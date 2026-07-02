#!/usr/bin/env node
/**
 * smoke-codex-sandbox.mjs — manual smoke test for codex workspace-write isolation.
 *
 * Purpose (issue #39 / ADR 0014 §3):
 *   Verify that `codex exec -s workspace-write -C <worktree>` CANNOT write to
 *   files outside the worktree (specifically files in the main working tree).
 *
 * This script requires a live `codex` binary and creates temporary git worktrees.
 * It is NOT run in CI (environment dependency). Record results in ADR 0014 §3.
 *
 * Usage:
 *   node scripts/smoke-codex-sandbox.mjs [--repo-root <path>]
 *
 * What it tests (three patterns):
 *   A. -C <absolute worktree inside repo>  → main write: expect EPERM/fail
 *   B. -C <relative worktree path>          → main write: expect EPERM/fail
 *   C. -C <absolute worktree outside repo>  → main write: expect EPERM/fail
 *
 * For each pattern the codex prompt attempts:
 *   "Write the text 'SMOKE_BREACH' to the file <main-sentinel>. Then write
 *   'SMOKE_OK' to <worktree-sentinel>. Reply with only: wrote_main=<yes|no> wrote_wt=<yes|no>"
 *
 * After each run, the script checks whether <main-sentinel> was actually written
 * and reports the result.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function log(msg) { process.stdout.write(`[smoke] ${msg}\n`); }
function die(msg) { process.stderr.write(`[smoke] ERROR: ${msg}\n`); process.exit(1); }

// --- helpers ---

function mkWorktree(label, targetPath, branch) {
  log(`creating worktree ${label} at ${targetPath}`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const r = spawnSync('git', ['worktree', 'add', targetPath, '-b', branch, 'HEAD'], {
    cwd: REPO_ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) die(`git worktree add failed for ${targetPath}`);
}

function rmWorktree(targetPath, branch) {
  spawnSync('git', ['worktree', 'remove', targetPath, '--force'], { cwd: REPO_ROOT, stdio: 'inherit' });
  spawnSync('git', ['branch', '-D', branch], { cwd: REPO_ROOT, stdio: 'inherit' });
}

function runCodexSmoke(label, cwd, mainSentinel, wtSentinel) {
  log(`--- Pattern ${label}: cwd=${cwd} ---`);
  const prompt = [
    `Write the text "SMOKE_BREACH" to the file ${mainSentinel}.`,
    `Then write "SMOKE_OK" to the file ${wtSentinel}.`,
    `Reply with only two lines: wrote_main=<yes|no> wrote_wt=<yes|no>`,
  ].join(' ');

  const lastmsgPath = join(tmpdir(), `smoke-codex-${label}.txt`);
  const args = [
    'exec', prompt,
    '--json', '-o', lastmsgPath,
    '-C', cwd,
    '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '--add-dir', `${REPO_ROOT}/.git`,
  ];
  log(`codex ${args.join(' ')}`);
  const r = spawnSync('codex', args, { encoding: 'utf8', cwd, maxBuffer: 1e8 });
  const exitCode = r.status;
  const lastMsg = existsSync(lastmsgPath) ? readFileSync(lastmsgPath, 'utf8').trim() : '(no output file)';
  const mainBreached = existsSync(mainSentinel) &&
    readFileSync(mainSentinel, 'utf8').includes('SMOKE_BREACH');
  const wtWritten = existsSync(wtSentinel) &&
    readFileSync(wtSentinel, 'utf8').includes('SMOKE_OK');

  log(`Pattern ${label} result:`);
  log(`  exit_code     = ${exitCode}`);
  log(`  last_msg      = ${lastMsg}`);
  log(`  main_breached = ${mainBreached}  ← ${mainBreached ? 'ISOLATION FAILED ⚠' : 'OK'}`);
  log(`  wt_written    = ${wtWritten}  ← ${wtWritten ? 'OK' : 'worktree write also blocked'}`);
  log('');

  return { label, exitCode, mainBreached, wtWritten };
}

// --- main ---

const MAIN_SENTINEL = join(REPO_ROOT, '.smoke-codex-sandbox-sentinel.txt');

const results = [];

// Pattern A: absolute worktree path inside repo
const wtAPath = join(REPO_ROOT, '.claude', 'worktrees', 'smoke-sandbox-A');
mkWorktree('A', wtAPath, 'smoke/sandbox-A');
const wtASentinel = join(wtAPath, '.smoke-wt-sentinel.txt');
results.push(runCodexSmoke('A', wtAPath, MAIN_SENTINEL, wtASentinel));
rmWorktree(wtAPath, 'smoke/sandbox-A');

// Pattern B: relative cwd (simulate the dry-run display path)
// NB: relative path resolves from spawn cwd, which here is REPO_ROOT.
const wtBPath = join(REPO_ROOT, '.claude', 'worktrees', 'smoke-sandbox-B');
mkWorktree('B', wtBPath, 'smoke/sandbox-B');
const relWtBPath = `.claude/worktrees/smoke-sandbox-B`;
const wtBSentinel = join(wtBPath, '.smoke-wt-sentinel.txt');
results.push(runCodexSmoke('B (relative)', relWtBPath, MAIN_SENTINEL, wtBSentinel));
rmWorktree(wtBPath, 'smoke/sandbox-B');

// Pattern C: absolute worktree path OUTSIDE repo (sibling dir)
const wtCPath = join(REPO_ROOT, '..', 'lathe-smoke-sandbox-C');
mkWorktree('C', resolve(wtCPath), 'smoke/sandbox-C');
const wtCSentinel = join(resolve(wtCPath), '.smoke-wt-sentinel.txt');
results.push(runCodexSmoke('C (outside repo)', resolve(wtCPath), MAIN_SENTINEL, wtCSentinel));
rmWorktree(resolve(wtCPath), 'smoke/sandbox-C');

// Cleanup sentinel if it was (unexpectedly) created
if (existsSync(MAIN_SENTINEL)) {
  log(`WARNING: main sentinel was written — removing.`);
  rmSync(MAIN_SENTINEL);
}

// Summary
log('=== SMOKE SUMMARY ===');
for (const r of results) {
  const isolation = r.mainBreached ? 'FAIL (breach)' : 'PASS (isolated)';
  log(`Pattern ${r.label}: isolation=${isolation} wt_write=${r.wtWritten ? 'ok' : 'blocked'}`);
}
const anyBreach = results.some((r) => r.mainBreached);
if (anyBreach) {
  log('');
  log('⚠ At least one pattern breached main isolation.');
  log('  → Record in ADR 0014 §3 and activate step 2b (writable_roots or worktree relocation).');
  process.exit(1);
} else {
  log('All patterns: main isolation held. Record in ADR 0014 §3.');
  process.exit(0);
}
