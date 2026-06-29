#!/usr/bin/env node
// preflight — single consolidated verify entry. Detects the changed paths and runs
// the gate (rubrics/run.mjs) at the right COST TIER. All verification — gate cmd
// checks, tsc, unit, e2e, storybook, ingest integration, codex judges — is now
// expressed as scoped + tiered rubrics, and run.mjs is the one engine: scope decides
// WHICH rubrics fire (by changed path), tier decides HOW DEEP. preflight just picks
// the tier and feeds run.mjs the changed paths.
//
//   --quick (Stop hook): tier=cmd   — fast deterministic checks only (~1-2s)
//   --fast             : tier=test  — + tsc + unit
//   --full             : tier=heavy — everything (e2e / storybook / integration / judges) = merge gate
import { execSync, spawnSync } from 'node:child_process';

const mode = process.argv.includes('--full') ? 'full' : process.argv.includes('--fast') ? 'fast' : 'quick';
const tier = mode === 'full' ? 'heavy' : mode === 'fast' ? 'test' : 'cmd';

let status = '';
try {
  status = execSync('git status --porcelain', { encoding: 'utf8', maxBuffer: 1e7 });
} catch {
  status = '';
}

// changed = uncommitted working-tree / index paths, minus personal untracked.
const changed = status
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean)
  .filter((p) => !p.startsWith('.agents/') && p !== 'skills-lock.json');

if (!changed.length) {
  console.log('[preflight] no changes — nothing to verify');
  process.exit(0);
}

console.log(`[preflight:${mode}] tier=${tier} changed=${changed.length}`);
const r = spawnSync('node', ['rubrics/run.mjs', '--changed', ...changed, '--tier', tier], { stdio: 'inherit' });
process.exit(r.status ?? 0);
