#!/usr/bin/env node
// rubrics/_schema.mjs — rubric schema v2 の必須要素を検証する（ADR 0010 / design/rubric-schema-v2.md）。
//   CLI:    node rubrics/_schema.mjs  → 全 rubric.json を走査し違反を `VIOLATION <id> <check|-> <理由>` で出力（exit 0）。
//   module: import { validateRubric } from './_schema.mjs'  → 単一 rubric を検証（負テスト用）。
//   schema_version:"2" の rubric だけ検証する。無いもの(v1)はスキップ(漸進移行)。
//   exit は常に 0（判定は meta/rubric-schema 側の `grep -c '^VIOLATION'` が行う＝run.mjs の cmd 評価方式に合わせる）。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SEVERITIES = ['blocker', 'major', 'minor'];
const METRICS = ['count', 'measure'];

// run.mjs の evalExpect が解釈する形だけを妥当とする: exit0 / empty / {eq|le|ge|contains}:<val>
function validExpect(expect) {
  if (typeof expect !== 'string') return false;
  if (expect === 'exit0' || expect === 'empty') return true;
  if (!expect.includes(':')) return false;
  return ['eq', 'le', 'ge', 'contains'].includes(expect.split(':')[0]);
}

// 単一 rubric を検証。返り値 = `<check-id|-> <理由>` の配列（空 = 合格）。v1 は空（対象外）。
export function validateRubric(r, id) {
  const out = [];
  const add = (cid, msg) => out.push(`${cid || '-'} ${msg}`);
  if (!r || typeof r !== 'object') { add('-', 'rubric が object でない'); return out; }
  if (r.schema_version !== '2') return out; // v1 = 漸進移行のためスキップ

  // --- rubric レベル ---
  if (r.id !== id) add('-', `id "${r.id}" がディレクトリ "${id}" と不一致`);
  if (!r.title) add('-', 'title 欠落');
  if (!r.version) add('-', 'version 欠落');
  if (!Array.isArray(r.scope) || r.scope.length < 1) add('-', 'scope は 1 件以上必須');
  if (!Array.isArray(r.checks) || r.checks.length < 1) { add('-', 'checks は 1 件以上必須'); return out; }

  // --- 選定層向け任意フィールド（ADR 0021 前線 D）---
  if (r.invariant !== undefined && typeof r.invariant !== 'boolean') add('-', 'invariant は boolean');
  if (r.edges !== undefined) {
    if (!Array.isArray(r.edges)) add('-', 'edges は配列');
    else r.edges.forEach((e, i) => {
      if (!e || !e.from) add('-', `edges[${i}].from 欠落`);
      if (!e || !e.reason) add('-', `edges[${i}].reason 欠落`);
    });
  }

  // --- check レベル ---
  for (const c of r.checks) {
    const cid = c.id || '-';
    if (!c.id) add(cid, 'check.id 欠落');
    if (!c.value) add(cid, 'check.value 欠落');
    if (!SEVERITIES.includes(c.severity)) add(cid, `severity は ${SEVERITIES.join('|')} 必須（現: ${c.severity}）`);

    const vf = c.verify;
    if (!vf || typeof vf !== 'object') { add(cid, 'verify 欠落'); continue; }
    if (!['cmd', 'judge'].includes(vf.kind)) add(cid, `verify.kind は cmd|judge 必須（現: ${vf.kind}）`);
    if (vf.kind === 'cmd' && !vf.cmd && !(vf.verifier && vf.channel))
      add(cid, 'kind=cmd なら verify.cmd か verifier+channel（named verifier への名前結合、ADR 0020）のどちらか必須');
    if (vf.cmd && vf.verifier) add(cid, 'verify.cmd と verify.verifier の同時指定は不可（実行元が二重になる）');
    if (vf.verifier && !vf.channel) add(cid, 'verify.verifier には channel 必須（どの出力チャンネルを読むか）');
    if (vf.kind === 'judge' && !(vf.judge && vf.judge.prompt && vf.judge.input_cmd))
      add(cid, 'kind=judge なら verify.judge.{prompt,input_cmd} 必須');
    if (!validExpect(vf.expect)) add(cid, `verify.expect が不正（現: ${vf.expect}）`);
    if (!METRICS.includes(vf.metric)) add(cid, `verify.metric は count|measure 必須（現: ${vf.metric}）`);

    if (vf.exemptions !== undefined) {
      if (!Array.isArray(vf.exemptions)) add(cid, 'verify.exemptions は配列');
      else vf.exemptions.forEach((ex, i) => {
        if (!ex || !ex.target) add(cid, `exemptions[${i}].target 欠落`);
        if (!ex || !ex.reason) add(cid, `exemptions[${i}].reason 欠落`);
      });
    }
  }
  return out;
}

function findRubrics(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...findRubrics(join(dir, e.name)));
    else if (e.name === 'rubric.json') out.push(join(dir, e.name));
  }
  return out;
}

// CLI（直接実行時のみ。import 時は走らない）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const lines = [];
  for (const file of findRubrics(here)) {
    const id = relative(here, dirname(file));
    let r;
    try { r = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { lines.push(`VIOLATION ${id} - JSON parse error: ${e.message}`); continue; }
    for (const msg of validateRubric(r, id)) lines.push(`VIOLATION ${id} ${msg}`);
  }
  for (const l of lines) console.log(l);
  process.exit(0);
}
