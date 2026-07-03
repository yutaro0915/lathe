#!/usr/bin/env node
// rubrics/bindings/lint.mjs — skill ⇄ rubric ⇄ eval の結合を集計・検証する（ADR 0018 前線 A）。
//   CLI:    node rubrics/bindings/lint.mjs            → VIOLATION 行を出力し、最終行に件数（exit 0）
//           node rubrics/bindings/lint.mjs --report   → 結合一覧 / 版見直し待ちキュー / 宙に浮き rubric（生成物・判定に使わない）
//   module: parseGroundedIn / parseEvalFile / computeBindings（負テスト用: rubrics/bindings/lint.test.mjs）
//
// 原則（theory §関係の管理）: 関係は出す側の artifact 内メタデータ（skill frontmatter の
// grounded_in / eval の checks）に書き、一覧・見直し待ち・宙に浮きは lint が集計して出す生成物。
// gate（RED）にするのは参照実在のみ。staleness は結果整合＝見直し待ちキュー（--report）。
// 手で維持する対応表は作らない。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// --- 純関数（負テスト対象） ---

// SKILL.md 全文から frontmatter（--- 〜 ---）を取り出す。無ければ null。
export function extractFrontmatter(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  return m ? m[1] : null;
}

// frontmatter テキストから grounded_in を読む（制約付き書式・行スキャン）:
//   grounded_in: []                       … 明示空
//   grounded_in:                          … block 形式
//     - rubric: <id>
//       verified: "<数字>"
// 返り値: { declared, entries: [{rubric, verified}], errors: [msg] }
export function parseGroundedIn(fmText) {
  const res = { declared: false, entries: [], errors: [] };
  if (fmText == null) {
    res.errors.push('frontmatter が無い');
    return res;
  }
  const lines = String(fmText).split('\n');
  const head = lines.findIndex((l) => /^grounded_in:/.test(l));
  if (head < 0) return res; // 未宣言（declared: false）
  res.declared = true;

  const rest = lines[head].replace(/^grounded_in:/, '').trim();
  if (rest === '[]') return res; // 明示空
  if (rest !== '') {
    res.errors.push(`grounded_in の値が不正: "${rest}"（[] か block 形式のみ）`);
    return res;
  }
  let current = null;
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 次の top-level key
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+rubric:\s*(.+?)\s*$/);
    const ver = line.match(/^\s+verified:\s*(.+?)\s*$/);
    if (item) {
      current = { rubric: stripQuotes(item[1]), verified: null };
      res.entries.push(current);
    } else if (ver && current) {
      current.verified = stripQuotes(ver[1]);
    } else {
      res.errors.push(`grounded_in block の解釈不能な行: "${line.trim()}"`);
    }
  }
  return res;
}

// eval ファイル（frontmatter 付き md）から id と checks を読む。
// 返り値: { id, checks: [rubric id], errors: [msg] }
export function parseEvalFile(text) {
  const res = { id: null, checks: [], errors: [] };
  const fm = extractFrontmatter(text);
  if (fm == null) {
    res.errors.push('frontmatter が無い');
    return res;
  }
  const lines = fm.split('\n');
  const idLine = lines.find((l) => /^id:\s*\S/.test(l));
  if (idLine) res.id = stripQuotes(idLine.replace(/^id:/, '').trim());
  else res.errors.push('id 欠落');

  const head = lines.findIndex((l) => /^checks:/.test(l));
  if (head < 0) {
    res.errors.push('checks 欠落');
    return res;
  }
  const rest = lines[head].replace(/^checks:/, '').trim();
  if (rest === '[]') return res;
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) res.checks.push(stripQuotes(item[1]));
    else res.errors.push(`checks block の解釈不能な行: "${line.trim()}"`);
  }
  return res;
}

// 集計本体。skills=[{name, groundedIn}] / evals=[{file, parsed}] / rubrics=Map<id,{version}>
// 返り値: { violations: [{kind, detail}], stale, unreferenced, bindings }
export function computeBindings({ skills, evals, rubrics }) {
  const violations = [];
  const stale = [];
  const bindings = [];
  const referenced = new Set();

  for (const s of skills) {
    const g = s.groundedIn;
    if (!g.declared) {
      violations.push({ kind: 'missing-grounded-in', detail: `skill=${s.name} grounded_in が未宣言（空なら [] を明示）` });
      continue;
    }
    for (const e of g.errors) violations.push({ kind: 'parse-error', detail: `skill=${s.name} ${e}` });
    for (const entry of g.entries) {
      const target = rubrics.get(entry.rubric);
      if (!target) {
        violations.push({ kind: 'unknown-rubric', detail: `skill=${s.name} rubric=${entry.rubric} が実在しない` });
        continue;
      }
      referenced.add(entry.rubric);
      if (target.version == null) {
        violations.push({ kind: 'unversioned-rubric', detail: `skill=${s.name} rubric=${entry.rubric} に version が無い（v1。名前結合には版が要る＝v2 化してから結合する）` });
        continue;
      }
      if (entry.verified == null || !/^\d+$/.test(entry.verified)) {
        violations.push({ kind: 'bad-verified', detail: `skill=${s.name} rubric=${entry.rubric} の verified が不正（現: ${entry.verified}）` });
        continue;
      }
      const isStale = entry.verified !== String(target.version);
      if (isStale) stale.push({ skill: s.name, rubric: entry.rubric, verified: entry.verified, current: String(target.version) });
      bindings.push({ from: `skill:${s.name}`, rubric: entry.rubric, verified: entry.verified, current: String(target.version), stale: isStale });
    }
    if (g.entries.length === 0 && g.errors.length === 0) {
      bindings.push({ from: `skill:${s.name}`, rubric: null, verified: null, current: null, stale: false });
    }
  }

  for (const ev of evals) {
    const p = ev.parsed;
    for (const e of p.errors) violations.push({ kind: 'parse-error', detail: `eval=${p.id ?? ev.file} ${e}` });
    for (const checkId of p.checks) {
      if (!rubrics.has(checkId)) {
        violations.push({ kind: 'unknown-check', detail: `eval=${p.id ?? ev.file} rubric=${checkId} が実在しない` });
        continue;
      }
      referenced.add(checkId);
      bindings.push({ from: `eval:${p.id ?? ev.file}`, rubric: checkId, verified: null, current: null, stale: false });
    }
  }

  const unreferenced = [...rubrics.keys()].filter((id) => !referenced.has(id)).sort();
  return { violations, stale, unreferenced, bindings };
}

function stripQuotes(s) {
  return String(s).replace(/^["']|["']$/g, '');
}

// --- CLI（FS 走査） ---

function scanSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(dir, d.name, 'SKILL.md') }))
    .filter((s) => existsSync(s.path))
    .map((s) => ({ name: s.name, groundedIn: parseGroundedIn(extractFrontmatter(readFileSync(s.path, 'utf8'))) }));
}

function scanEvals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, parsed: parseEvalFile(readFileSync(join(dir, f), 'utf8')) }));
}

function scanRubrics(dir) {
  const map = new Map();
  const walk = (d, rel) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      else if (entry.name === 'rubric.json' && rel) {
        try {
          const r = JSON.parse(readFileSync(join(d, entry.name), 'utf8'));
          map.set(rel, { version: r.version ?? null });
        } catch {
          map.set(rel, { version: null });
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return map;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const report = args.includes('--report');
  const skills = scanSkills(flag('--skills', '.claude/skills'));
  const evals = scanEvals(flag('--evals', 'evals'));
  const rubrics = scanRubrics(flag('--rubrics', 'rubrics'));
  const out = computeBindings({ skills, evals, rubrics });

  if (report) {
    console.log('## bindings（skill/eval → rubric）');
    for (const b of out.bindings) {
      if (b.rubric == null) console.log(`- ${b.from} → (grounded_in: [] 明示)`);
      else if (b.verified != null) console.log(`- ${b.from} → ${b.rubric} verified=${b.verified} current=${b.current} [${b.stale ? 'STALE' : 'ok'}]`);
      else console.log(`- ${b.from} → ${b.rubric} [ok]`);
    }
    console.log('\n## 版見直し待ちキュー（stale — 判定に使わない・結果整合）');
    if (out.stale.length === 0) console.log('（なし）');
    for (const s of out.stale) console.log(`- skill:${s.skill} → ${s.rubric} verified=${s.verified} → current=${s.current}（再検証して verified を上げる）`);
    console.log('\n## 宙に浮き rubric（どの skill/eval からも参照されない — 情報）');
    for (const id of out.unreferenced) console.log(`- ${id}`);
    console.log(`\n計: skills=${skills.length} evals=${evals.length} rubrics=${rubrics.size} stale=${out.stale.length} violations=${out.violations.length}`);
    process.exit(0);
  }

  for (const v of out.violations) console.log(`VIOLATION ${v.kind}: ${v.detail}`);
  console.log(out.violations.length);
  process.exit(0);
}
