#!/usr/bin/env node
// gf-ratchet — grandfather sunset gate (ratchet only).
// Fails (prints a non-zero violation count on the last line) if the .oxlintrc
// file-size overrides GREW vs the committed baseline: i.e. any override's max
// INCREASED, or a NEW override was added. Lowering a max or REMOVING an override
// (file split below 500) is allowed — that is the intended reduction.
// Output: integer count on the last stdout line for rubrics/run.mjs (expect eq:0).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // rubrics/file-size
const repo = join(here, '..', '..');                  // -> repo root
const oxlint = JSON.parse(readFileSync(join(repo, '.oxlintrc.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(here, 'gf-baseline.json'), 'utf8')).overrides;

const maxOf = (rule) =>
  Array.isArray(rule) && rule[1] && typeof rule[1].max === 'number' ? rule[1].max : null;

const current = {};
for (const o of oxlint.overrides || []) {
  const key = (o.files || []).join('|');
  const m = maxOf(o.rules && o.rules['max-lines']);
  if (m != null) current[key] = m;
}

const violations = [];
for (const [glob, max] of Object.entries(current)) {
  if (!(glob in baseline)) violations.push(`NEW grandfather: ${glob} (max ${max}) — not in baseline; reduce or update baseline (auditor)`);
  else if (max > baseline[glob]) violations.push(`LOOSENED: ${glob} ${baseline[glob]} -> ${max} — ceilings are ratchet-only (never raise)`);
}
for (const v of violations) console.error(v);
console.log(violations.length);
