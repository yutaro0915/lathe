#!/usr/bin/env node
// preflight — single consolidated verify entry. Runs ONLY the layers affected by
// the current uncommitted changes (git working tree vs HEAD).
//
//   --quick (Stop hook): cmd-gate only (codex judges skipped). ~1-2s heads-up.
//   --fast            : cmd-gate (judges skipped) + tsc + unit. Quick local check.
//   --full            : full gate (incl judges/e2e) + tsc + unit + scope integration + storybook. Merge gate.
//
// The command bodies live HERE so the Stop hook (and implementer self-checks /
// verifier) all call ONE entry instead of re-typing. The gate stays the single
// source: preflight CALLS `rubrics/run.mjs`, it never reimplements gate logic.
import { execSync } from 'node:child_process';

const mode = process.argv.includes('--full')
  ? 'full'
  : process.argv.includes('--quick')
    ? 'quick'
    : 'fast';

function sh(cmd, extraEnv = {}) {
  try {
    const out = execSync(cmd, {
      shell: '/bin/bash',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
      maxBuffer: 1e7,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim() };
  }
}

const tail = (s, n = 1) => s.split('\n').filter(Boolean).slice(-n).join(' ');

// changed = uncommitted working-tree / index paths vs HEAD, code only (skip personal untracked).
const changed = sh('git status --porcelain').out
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean)
  .filter((p) => !p.startsWith('.agents/') && p !== 'skills-lock.json');
const code = changed.filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx|css|json|sql)$/.test(p));

if (!code.length) {
  console.log('[preflight] no code changes — nothing to verify');
  process.exit(0);
}

const tsChanged = code.some((p) => /\.(ts|tsx)$/.test(p));
const unitRelevant = code.some((p) => /^(packages\/|apps\/web\/(lib|components|scripts)\/)/.test(p));
const ingestChanged = code.some((p) => p.startsWith('apps/web/scripts/ingest'));
const storybookRelevant = code.some((p) => p.startsWith('apps/web/design-system') || /\.stories\.tsx$/.test(p));

const results = [];
const run = (name, cmd, env) => {
  const r = sh(cmd, env);
  results.push({ name, ok: r.ok, out: r.out });
};

// 1. gate (always). --quick / --fast skip codex agent-judge checks via RUBRIC_SKIP_JUDGE.
run('gate', `node rubrics/run.mjs --changed ${code.join(' ')}`, mode === 'full' ? {} : { RUBRIC_SKIP_JUDGE: '1' });

// 2. tsc + unit (skipped in --quick to stay snappy for the Stop hook)
if (mode !== 'quick') {
  if (tsChanged) run('tsc', 'pnpm -C apps/web exec tsc --noEmit');
  if (unitRelevant) run('unit', 'pnpm test');
}

// 3. storybook & integration (full only, by scope)
if (mode === 'full' && storybookRelevant) run('storybook', 'pnpm -C apps/web test-storybook');
if (mode === 'full' && ingestChanged) {
  for (const v of ['verify:incremental', 'verify:subagent-relink', 'verify:subagents']) {
    run(v, `DATABASE_URL=postgres://lathe:lathe@localhost:55433/lathe pnpm -C apps/web run ${v}`);
  }
}

console.log(`[preflight:${mode}] changed=${code.length} → layers: ${results.map((r) => r.name).join(', ')}`);
for (const r of results) {
  console.log(`  ${r.ok ? 'GREEN' : 'RED  '} ${r.name}: ${(r.ok ? tail(r.out, 1) : tail(r.out, 3)) || '(no output)'}`);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nRED: ${failed.map((r) => r.name).join(', ')}` : '\nGREEN');
process.exit(failed.length ? 1 : 0);
