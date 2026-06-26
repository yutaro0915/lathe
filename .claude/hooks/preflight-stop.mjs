#!/usr/bin/env node
// Stop hook (ADVISORY). On session end, if there are uncommitted CODE changes,
// run the quick gate (deterministic rubric checks, ~1-2s) and surface any RED.
// It NEVER blocks the stop (always exit 0) — a heads-up, not a gate. Thin: all
// command logic lives in scripts/preflight.mjs; this just invokes --quick and
// echoes the result.
import { execSync } from 'node:child_process';

try {
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith('.agents/') && p !== 'skills-lock.json')
    .some((p) => /\.(ts|tsx|mjs|cjs|js|jsx|css|json|sql)$/.test(p));
  if (!dirty) process.exit(0);
  const out = execSync('node scripts/preflight.mjs --quick', { encoding: 'utf8' });
  process.stderr.write(out);
} catch (e) {
  // preflight exits non-zero on RED — surface it, but DO NOT block the stop.
  process.stderr.write(`${e.stdout || ''}${e.stderr || ''}`);
}
process.exit(0);
