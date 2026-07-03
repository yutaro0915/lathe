#!/usr/bin/env node
// rubrics/_eval-schema.mjs — eval 形式 v1 の必須要素を検証する（ADR 0019 前線 B）。
//   CLI:    node rubrics/_eval-schema.mjs  → 全 evals/*.md を走査し違反を `VIOLATION <file> <理由>` で出力（exit 0）。
//   module: import { validateEval, parseEvalFull } from './_eval-schema.mjs'  → 負テスト用。
//   判定は meta/eval-schema 側の `grep -c '^VIOLATION'` が行う（_schema.mjs と同型）。
//
// 役割分担: eval 自体の構造＝本検証器 / checks が指す rubric の実在＝meta/bindings（前線 A、重複させない）。
// frontmatter の構文解釈は前線 A の parse 関数を import（二重実装しない）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { extractFrontmatter, parseEvalFile } from './bindings/lint.mjs';

const ROLES = ['development', 'assurance'];
const AGGREGATES = ['all-pass'];

// eval 全 frontmatter を読む。返り値: { id, role, frontier, S, C, Y, checks, checksDeclared,
//   inlineCriteria, inlineDeclared, trials: {n, aggregate} | null, errors: [] }
export function parseEvalFull(text) {
  const res = {
    id: null, role: null, frontier: null, S: null, C: null, Y: null,
    checks: [], checksDeclared: false, inlineCriteria: [], inlineDeclared: false,
    trials: null, errors: [],
  };
  const fm = extractFrontmatter(text);
  if (fm == null) {
    res.errors.push('frontmatter が無い');
    return res;
  }
  const lines = fm.split('\n');
  const scalar = (key) => {
    const line = lines.find((l) => new RegExp(`^${key}:\\s*\\S`).test(l));
    return line ? line.replace(new RegExp(`^${key}:`), '').trim() : null;
  };
  res.id = scalar('id');
  res.role = scalar('role');
  res.frontier = scalar('frontier');
  res.S = scalar('S');
  res.C = scalar('C');
  res.Y = scalar('Y');

  const evalParsed = parseEvalFile(text); // checks の解釈は前線 A と同一
  res.checks = evalParsed.checks;
  res.checksDeclared = lines.some((l) => /^checks:/.test(l));

  const inlineHead = lines.findIndex((l) => /^inline_criteria:/.test(l));
  if (inlineHead >= 0) {
    res.inlineDeclared = true;
    const rest = lines[inlineHead].replace(/^inline_criteria:/, '').trim();
    if (rest !== '' && rest !== '[]') res.errors.push(`inline_criteria の値が不正: "${rest}"（[] か block 形式のみ）`);
    if (rest === '') {
      for (let i = inlineHead + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\S/.test(line)) break;
        if (!line.trim()) continue;
        const item = line.match(/^\s+-\s+(.+?)\s*$/);
        if (item) res.inlineCriteria.push(item[1]);
        else res.errors.push(`inline_criteria block の解釈不能な行: "${line.trim()}"`);
      }
    }
  }

  const trialsLine = lines.find((l) => /^trials:/.test(l));
  if (trialsLine) {
    const m = trialsLine.match(/^trials:\s*\{\s*n:\s*(\d+)\s*,\s*aggregate:\s*([a-zA-Z-]+)\s*\}\s*$/);
    if (m) res.trials = { n: Number(m[1]), aggregate: m[2] };
    else res.errors.push(`trials の書式が不正: "${trialsLine.trim()}"（{ n: <int>, aggregate: <enum> }）`);
  }
  return res;
}

// 単一 eval を検証。返り値 = 理由の配列（空 = 合格）。fileId = ファイル名（拡張子抜き）。
export function validateEval(parsed, fileId) {
  const out = [...parsed.errors];
  if (!parsed.id) out.push('id 欠落');
  else if (fileId != null && parsed.id !== fileId) out.push(`id "${parsed.id}" がファイル名 "${fileId}" と不一致`);
  if (!ROLES.includes(parsed.role)) out.push(`role は ${ROLES.join('|')} 必須（現: ${parsed.role}）`);
  if (!parsed.frontier) out.push('frontier 欠落');
  for (const k of ['S', 'C', 'Y']) if (!parsed[k]) out.push(`${k} 欠落（S/C/Y は空でない文字列必須）`);
  if (!parsed.checksDeclared) out.push('checks 欠落（空なら [] を明示）');
  if (!parsed.inlineDeclared) out.push('inline_criteria 欠落（空なら [] を明示）');
  if (parsed.checksDeclared && parsed.inlineDeclared && parsed.checks.length === 0 && parsed.inlineCriteria.length === 0)
    out.push('checks と inline_criteria が両方空（判定基準ゼロの問いは受容主張になれない）');
  if (!parsed.trials) out.push('trials 欠落または書式不正');
  else {
    if (!Number.isInteger(parsed.trials.n) || parsed.trials.n < 1) out.push(`trials.n は 1 以上の整数（現: ${parsed.trials.n}）`);
    if (!AGGREGATES.includes(parsed.trials.aggregate)) out.push(`trials.aggregate は ${AGGREGATES.join('|')} 必須（現: ${parsed.trials.aggregate}）`);
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const dir = process.argv[2] ?? 'evals';
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      const parsed = parseEvalFull(readFileSync(join(dir, f), 'utf8'));
      for (const msg of validateEval(parsed, f.replace(/\.md$/, ''))) console.log(`VIOLATION ${f} ${msg}`);
    }
  }
  process.exit(0);
}
