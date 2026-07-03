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
import { readFileSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

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
const args = rawArgs;
let selected, changed = [];
if (args[0] === '--changed') {
  changed = args.slice(1);
  selected = all.filter((r) => (r.scope || []).some((s) => changed.some((c) => c === s || c.startsWith(s.endsWith('/') ? s : s + '/'))));
  console.log(`changed: ${changed.join(' ')}`);
  console.log(`→ 発火するルーブリック: ${selected.map((r) => r.id).join(', ') || '(なし — このスコープを覆う規則は無い)'}`);
} else {
  selected = all.filter((r) => args.includes(r.id));
}
if (!selected.length) { console.error('対象ルーブリック無し'); process.exit(args[0] === '--changed' ? 0 : 2); }
process.env.RUBRIC_CHANGED_PATHS = JSON.stringify(changed);

let failed = 0, total = 0;
for (const r of selected) {
  console.log(`\n# ${r.id} — ${r.title}  [scope: ${(r.scope || []).join(' ')}]`);
  for (const c of r.checks) {
    const v = c.verify || {};
    // cost tier: explicit verify.tier, else judges default heavy / cmd checks default cmd.
    // --tier keeps only checks at or below the requested tier (Stop hook=cmd, merge=heavy).
    const tier = v.tier ?? (v.judge ? 'heavy' : 'cmd');
    if ((TIER_RANK[tier] ?? 2) > maxTierRank) {
      console.log(`  [SKIP ] ${c.id} (tier=${tier} > requested)`);
      continue;
    }
    total++;
    const how = v.judge ? 'judge' : v.verifier ? `verifier:${v.verifier}#${v.channel}` : 'cmd';
    let out = '', threw = false;
    try {
      if (v.verifier && !v.judge) {
        const { def, out: evidence, exitCode } = runVerifierOnce(v.verifier);
        const ch = (def.produces || {})[v.channel];
        if (!ch) throw new Error(`verifier "${v.verifier}" に channel "${v.channel}" が無い`);
        out = ch.source === 'exit'
          ? String(exitCode)
          : execSync(ch.extract, { input: evidence, shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1e7 }).trim();
      } else if (v.judge) {
        const art = v.judge.input_cmd
          ? execSync(v.judge.input_cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e7 })
          : '';
        const prompt = `${v.judge.prompt}\n\n--- 対象 ---\n${art}\n--- 指示 ---\n違反に当たるものの数を数え、最終行に必ず VERDICT:<整数> だけを出力しろ（前置き・説明は可だが最終行は VERDICT: 形式）。`;
        // judge のモデル束縛は judge-runner が集約（要求クラス間接、ADR 0020）。class 省略時 standard。
        const binding = judgeBinding(v.class ?? 'standard');
        if (binding.provider !== 'codex') throw new Error(`judge-runner: provider "${binding.provider}" は未対応（v1 は codex のみ）`);
        const judgeArgs = ['exec', '--skip-git-repo-check', ...(binding.model ? ['-m', binding.model] : []), prompt];
        const raw = execFileSync('codex', judgeArgs, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e7 });
        const ms = raw.match(/VERDICT:\s*(-?\d+)/g);
        out = ms ? ms[ms.length - 1].replace(/VERDICT:\s*/, '') : (raw.trim().split('\n').pop() || '');
      } else {
        out = execSync(v.cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1e7 }).trim();
      }
    } catch (e) { threw = true; out = ((e.stdout || '') + (e.stderr || '')).trim(); }
    const ok = evalExpect(v.expect, out, threw);
    if (!ok) failed++;
    console.log(`  [${ok ? 'GREEN' : 'RED  '}] ${c.id} (${how}, expect ${v.expect}) → ${out.split('\n').pop() || '(no output)'}`);
    if (!ok) console.log(`        ↳ 壊れたドメイン価値: ${c.value || '(value 未記載 = スキーマ違反)'}`);
  }
}
console.log(`\n${failed ? 'RED' : 'GREEN'}: ${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);

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
