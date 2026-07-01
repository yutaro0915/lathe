#!/usr/bin/env node
// session-class-taxonomy — drift gate (ADR 0012 §5, issue #22).
//
// Keeps the TYPE (code) and the DOMAIN DECISION (ADR) in sync: the set of
// session classes in `SESSION_CLASSES` (apps/web/scripts/ingest/domain/session-class.ts)
// must equal the taxonomy documented in ADR 0012 decision §2's table. Add or
// remove a class in one place without the other → non-zero (RED), forcing both
// to be updated together.
//
// Output: integer symmetric-difference size on the last stdout line (rubrics/run.mjs, expect eq:0).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd(); // run.mjs invokes cmd checks from the repo root

function readOr(path) {
  try {
    return readFileSync(join(repo, path), 'utf8');
  } catch {
    return null;
  }
}

const violations = [];

// --- code side: SESSION_CLASSES canonical array ---
const src = readOr('apps/web/scripts/ingest/domain/session-class.ts');
const codeClasses = new Set();
if (!src) {
  violations.push('session-class.ts not found');
} else {
  const arr = src.match(/SESSION_CLASSES\s*:\s*readonly\s+SessionClass\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (!arr) violations.push('SESSION_CLASSES array literal not found in session-class.ts');
  else for (const m of arr[1].matchAll(/'([a-z_]+)'/g)) codeClasses.add(m[1]);
}
if (codeClasses.size === 0) violations.push('extracted 0 classes from SESSION_CLASSES');

// --- ADR side: decision §2 taxonomy table (first cell = `class`) ---
const adr = readOr('adr/0012-session-class-axis.md');
const adrClasses = new Set();
if (!adr) {
  violations.push('adr/0012-session-class-axis.md not found');
} else {
  // Scope to decision "### 2." up to the next "### " / "## " heading.
  const sec = adr.match(/###\s*2\.[\s\S]*?(?=\n###\s|\n##\s|$)/);
  const section = sec ? sec[0] : adr;
  for (const m of section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)) adrClasses.add(m[1]);
}
if (adrClasses.size === 0) violations.push('extracted 0 classes from ADR 0012 §2 taxonomy table');

// --- symmetric difference ---
for (const c of codeClasses) if (!adrClasses.has(c)) violations.push(`code SESSION_CLASSES has '${c}' but ADR §2 taxonomy lacks it`);
for (const c of adrClasses) if (!codeClasses.has(c)) violations.push(`ADR §2 taxonomy has '${c}' but code SESSION_CLASSES lacks it`);

for (const v of violations) console.error(v);
console.log(violations.length);
