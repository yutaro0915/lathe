#!/usr/bin/env node
// rubrics/run.mjs — cwd = 対象 worktree。
//   node rubrics/run.mjs <id...>             … 明示指定（id = rubrics/ からの相対パス）
//   node rubrics/run.mjs --changed <path...>  … 変更パスを「覆う」ルーブリックだけ選ぶ（scope 封じ込め）
//
// 設計（ユーザー指示 2026-06-18）:
//  - 1 関心 1 ルーブリック（1 ディレクトリ = 1 rubric.json）。スコープの大小はディレクトリ（コードパス鏡写し）。
//  - check の既約最小 = { value（ドメイン価値: 何の性質を・なぜ）, verify（cmd→expect: どう機械検証） } の不可分ペア。
//  - --changed では scope[] が変更パスを覆う rubric だけ発火 → 狭い規則が全体に漏れない。
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function findRubrics(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...findRubrics(join(dir, e.name)));
    else if (e.name === 'rubric.json') out.push(join(dir, e.name));
  }
  return out;
}

const all = findRubrics(here).map((f) => ({ id: relative(here, dirname(f)), ...JSON.parse(readFileSync(f, 'utf8')) }));

const args = process.argv.slice(2);
let selected;
if (args[0] === '--changed') {
  const changed = args.slice(1);
  selected = all.filter((r) => (r.scope || []).some((s) => changed.some((c) => c === s || c.startsWith(s.endsWith('/') ? s : s + '/'))));
  console.log(`changed: ${changed.join(' ')}`);
  console.log(`→ 発火するルーブリック: ${selected.map((r) => r.id).join(', ') || '(なし — このスコープを覆う規則は無い)'}`);
} else {
  selected = all.filter((r) => args.includes(r.id));
}
if (!selected.length) { console.error('対象ルーブリック無し'); process.exit(args[0] === '--changed' ? 0 : 2); }

let failed = 0, total = 0;
for (const r of selected) {
  console.log(`\n# ${r.id} — ${r.title}  [scope: ${(r.scope || []).join(' ')}]`);
  for (const c of r.checks) {
    total++;
    const v = c.verify || {};
    let out = '', threw = false;
    try { out = execSync(v.cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch (e) { threw = true; out = ((e.stdout || '') + (e.stderr || '')).trim(); }
    const ok = evalExpect(v.expect, out, threw);
    if (!ok) failed++;
    console.log(`  [${ok ? 'GREEN' : 'RED  '}] ${c.id} (expect ${v.expect}) → ${out.split('\n').pop() || '(no output)'}`);
    if (!ok) console.log(`        ↳ 壊れたドメイン価値: ${c.value || '(value 未記載 — スキーマ違反)'}`);
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
