#!/usr/bin/env node
// rubrics/run.mjs — cwd = 対象 worktree。
//   node rubrics/run.mjs <id...>             … 明示指定（id = rubrics/ からの相対パス）
//   node rubrics/run.mjs --changed <path...>  … 変更パスを「覆う」ルーブリックだけ選ぶ（scope 封じ込め）
//
// 設計（ユーザー指示 2026-06-18）:
//  - 規範の正本は rubric のみ（audit-protocol 等の別レイヤーを持たない）。1 関心 1 ルーブリック。スコープはディレクトリ（コードパス鏡写し）。
//  - check の既約最小 = { value（ドメイン価値）, verify（どう機械検証するか） }。**人間レビューの逃げ（review_focus）は禁止**。
//  - 機械で検査できない性質も検査方法を作る:
//      verify.cmd   … shell で測れる性質（grep/lint/test 等）。
//      verify.judge … 測りにくい性質は agent をジャッジに呼ぶ（input_cmd で対象を集め、codex に違反数を VERDICT:<int> で返させる）。
//      verify.verifier+channel … named verifier（verifiers/<id>/verifier.json、ADR 0020）への名前結合。
//        verifier の run は 1 回の run.mjs 呼び出しにつき 1 回だけ実行され（memoize）、チャンネルの
//        extract（出力を stdin に受ける）か source:"exit" で値を取り出す。判定（evalExpect）は不変。
//  - --changed では scope[] が変更パスを覆う rubric だけ発火 → 狭い規則が全体に漏れない。RUBRIC_CHANGED_PATHS で check が変更パスを参照できる（slice 封じ込め）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { selectRubrics, buildReverseGraph } from './select.mjs';
import { classifyCheck, aggregate } from './verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VERIFIERS_DIR = join(here, '..', 'verifiers');
const verifierCache = new Map(); // id → { def, out, exitCode } — 1 run.mjs 呼び出しにつき 1 実行（ADR 0020）
function runVerifierOnce(id) {
  if (verifierCache.has(id)) return verifierCache.get(id);
  const def = JSON.parse(readFileSync(join(VERIFIERS_DIR, id, 'verifier.json'), 'utf8'));
  let out = '', exitCode = 0;
  try {
    out = execSync(def.run, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1e7 });
  } catch (e) { out = ((e.stdout || '') + (e.stderr || '')); exitCode = e.status ?? 1; }
  console.log(`  [VERIF] ${id} を実行（exit=${exitCode}・以後この run では memoize）`);
  const entry = { def, out, exitCode };
  verifierCache.set(id, entry);
  return entry;
}
let judgeRunnerCfg = null;
function judgeBinding(cls) {
  if (!judgeRunnerCfg) judgeRunnerCfg = JSON.parse(readFileSync(join(VERIFIERS_DIR, 'judge-runner', 'verifier.json'), 'utf8'));
  const b = (judgeRunnerCfg.bindings || {})[cls];
  if (!b) throw new Error(`judge-runner に class "${cls}" の binding が無い（クラス語彙の不足＝runner に追加してから使う）`);
  return b;
}
function findRubrics(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...findRubrics(join(dir, e.name)));
    else if (e.name === 'rubric.json') out.push(join(dir, e.name));
  }
  return out;
}
const all = findRubrics(here).map((f) => ({ id: relative(here, dirname(f)), ...JSON.parse(readFileSync(f, 'utf8')) }));

const rawArgs = process.argv.slice(2);
// --tier <cmd|test|heavy>: run only checks up to that cost tier (default heavy = all).
// cmd = fast deterministic (grep/lint) — Stop hook; test = + tsc/unit; heavy = + e2e/integration/storybook/judge.
const TIER_RANK = { cmd: 0, test: 1, heavy: 2 };
let maxTierRank = 2;
const tierIdx = rawArgs.indexOf('--tier');
if (tierIdx >= 0) {
  maxTierRank = TIER_RANK[rawArgs[tierIdx + 1]] ?? 2;
  rawArgs.splice(tierIdx, 2);
}
// --receipt <path>: 選定 receipt（発火 rubric とその規則・not-run 全列挙）を JSON で書き出す（ADR 0021 前線 D）。
let receiptPath = null;
const receiptIdx = rawArgs.indexOf('--receipt');
if (receiptIdx >= 0) {
  receiptPath = rawArgs[receiptIdx + 1];
  rawArgs.splice(receiptIdx, 2);
}
const args = rawArgs;
let selected, changed = [], selection = null;
if (args[0] === '--changed') {
  changed = args.slice(1);
  // 選定層（rubrics/select.mjs、ADR 0021 前線 D）: 影響集合 = changed ∪ 逆依存の推移閉包。
  // 発火 = invariant ∨ (scope ∩ 影響集合 ≠ ∅) ∨ declared-edge。旧規則（direct-scope）は上位集合として保持。
  const graph = buildReverseGraph(changed);
  selection = selectRubrics({ changed, graph, rubrics: all });
  const firedIds = new Set(selection.fired.map((f) => f.id));
  selected = all.filter((r) => firedIds.has(r.id));
  console.log(`changed: ${changed.join(' ')}`);
  console.log(`→ 発火するルーブリック:`);
  if (!selection.fired.length) console.log('  (なし — このスコープを覆う規則は無い)');
  for (const f of selection.fired) {
    console.log(`  [${f.rule}] ${f.id}${f.via ? ` (via: ${f.via})` : ''}`);
  }
  console.log(`→ not-run（未実施、silent skip でなく明示）: ${selection.notRun.join(', ') || '(なし)'}`);
} else {
  selected = all.filter((r) => args.includes(r.id));
}
if (!selected.length) { console.error('対象ルーブリック無し'); process.exit(args[0] === '--changed' ? 0 : 2); }
process.env.RUBRIC_CHANGED_PATHS = JSON.stringify(changed);

// VERDICT_LABEL: 表示・summary で使う等幅 5 文字ラベル（ADR 0022 前線2 §4）。
const VERDICT_LABEL = { pass: 'PASS ', fail: 'FAIL ', warn: 'WARN ', invalid: 'INVLD', 'not-run': 'NORUN' };

const checkRecords = []; // receipt 用: { rubric, check, verdict, attribution?, reason?, detail? }
for (const r of selected) {
  console.log(`\n# ${r.id} — ${r.title}  [scope: ${(r.scope || []).join(' ')}]`);
  for (const c of r.checks) {
    const v = c.verify || {};
    // cost tier: explicit verify.tier, else judges default heavy / cmd checks default cmd.
    // --tier keeps only checks at or below the requested tier (Stop hook=cmd, merge=heavy).
    const tier = v.tier ?? (v.judge ? 'heavy' : 'cmd');
    if ((TIER_RANK[tier] ?? 2) > maxTierRank) {
      const reason = `tier=${tier} > requested`;
      console.log(`  [${VERDICT_LABEL['not-run']}] ${c.id} (reason: ${reason})`);
      checkRecords.push({ rubric: r.id, check: c.id, verdict: 'not-run', reason });
      continue;
    }
    const how = v.judge ? 'judge' : v.verifier ? `verifier:${v.verifier}#${v.channel}` : 'cmd';
    let out = '', threw = false, procedureFailure = null;
    try {
      if (v.verifier && !v.judge) {
        let def, evidence, exitCode;
        try {
          ({ def, out: evidence, exitCode } = runVerifierOnce(v.verifier));
        } catch (e) {
          procedureFailure = { kind: 'verifier-resolution', detail: `verifier "${v.verifier}" の定義解決失敗: ${e.message}` };
          throw e;
        }
        const ch = (def.produces || {})[v.channel];
        if (!ch) {
          procedureFailure = { kind: 'missing-channel', detail: `verifier "${v.verifier}" に channel "${v.channel}" が無い` };
          throw new Error(procedureFailure.detail);
        }
        try {
          out = ch.source === 'exit'
            ? String(exitCode)
            : execSync(ch.extract, { input: evidence, shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1e7 }).trim();
        } catch (e) {
          procedureFailure = { kind: 'extract-failure', detail: `channel "${v.channel}" の extract 実行失敗: ${e.message}` };
          throw e;
        }
      } else if (v.judge) {
        const art = v.judge.input_cmd
          ? execSync(v.judge.input_cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e7 })
          : '';
        const prompt = `${v.judge.prompt}\n\n--- 対象 ---\n${art}\n--- 指示 ---\n違反に当たるものの数を数え、最終行に必ず VERDICT:<整数> だけを出力しろ（前置き・説明は可だが最終行は VERDICT: 形式）。`;
        // judge のモデル束縛は judge-runner が集約（要求クラス間接、ADR 0020）。class 省略時 standard。
        let binding;
        try {
          binding = judgeBinding(v.class ?? 'standard');
          if (binding.provider !== 'codex') throw new Error(`judge-runner: provider "${binding.provider}" は未対応（v1 は codex のみ）`);
        } catch (e) {
          procedureFailure = { kind: 'judge-binding-resolution', detail: e.message };
          throw e;
        }
        const judgeArgs = ['exec', '--skip-git-repo-check', ...(binding.model ? ['-m', binding.model] : []), prompt];
        let raw;
        try {
          raw = execFileSync('codex', judgeArgs, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e7 });
        } catch (e) {
          procedureFailure = { kind: 'judge-verdict-missing', detail: `judge 実行失敗/timeout: ${e.message}` };
          throw e;
        }
        const ms = raw.match(/VERDICT:\s*(-?\d+)/g);
        if (!ms) {
          procedureFailure = { kind: 'judge-verdict-missing', detail: 'judge 出力の最終行に VERDICT:<int> が無い' };
          throw new Error(procedureFailure.detail);
        }
        out = ms[ms.length - 1].replace(/VERDICT:\s*/, '');
      } else {
        // テスト対象コマンド自体の非ゼロ exit（tsc fail 等）は procedureFailure でなく従来どおり判定対象。
        out = execSync(v.cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1e7 }).trim();
      }
    } catch (e) { threw = true; out = ((e.stdout || '') + (e.stderr || '')).trim(); }
    const ok = procedureFailure ? false : evalExpect(v.expect, out, threw);
    const verdict = classifyCheck({ ok, severity: c.severity, procedureFailure });
    const label = VERDICT_LABEL[verdict];
    if (verdict === 'invalid') {
      console.log(`  [${label}] ${c.id} (${how}) → 帰属=harness ／ ${procedureFailure.kind}: ${procedureFailure.detail}`);
      checkRecords.push({ rubric: r.id, check: c.id, verdict, attribution: 'harness', detail: `${procedureFailure.kind}: ${procedureFailure.detail}` });
    } else {
      console.log(`  [${label}] ${c.id} (${how}, expect ${v.expect}) → ${out.split('\n').pop() || '(no output)'}`);
      if (verdict === 'fail' || verdict === 'warn') console.log(`        ↳ 壊れたドメイン価値: ${c.value || '(value 未記載 = スキーマ違反)'}`);
      checkRecords.push({ rubric: r.id, check: c.id, verdict });
    }
  }
}

const summary = aggregate(checkRecords.map((cr) => cr.verdict));
console.log(
  `\nPASS ${summary.counts.pass} / FAIL ${summary.counts.fail} / WARN ${summary.counts.warn} / INVALID ${summary.counts.invalid} / NOT-RUN ${summary.counts.notRun} → ${summary.stop ? '停止' : '通過'}`
);

// 選定 receipt の JSON 書き出し（--receipt <path>、ADR 0021 前線 D §6・ADR 0022 前線2 §4 で checks を追加）。
// --changed 経路（selection が入っている）のときのみ選定情報は意味を持つ。明示指定モードでは selection は null。
if (receiptPath) {
  const receipt = {
    changed,
    fired: selection ? selection.fired : selected.map((r) => ({ id: r.id, rule: 'explicit-arg' })),
    notRun: selection ? selection.notRun : [],
    checks: checkRecords,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\n選定 receipt を書き出し: ${receiptPath}`);
}

process.exit(summary.stop ? 1 : 0);

function evalExpect(expect, out, threw) {
  const last = (out.split('\n').pop() || '').trim();
  const n = Number(last);
  if (expect === 'exit0') return !threw;
  if (expect === 'empty') return out === '';
  const [op, val] = String(expect).split(':');
  if (op === 'eq') return n === Number(val);
  if (op === 'le') return n <= Number(val);
  if (op === 'ge') return n >= Number(val);
  if (op === 'contains') return out.includes(val);
  return false;
}
