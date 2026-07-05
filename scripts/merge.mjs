#!/usr/bin/env node
// CLI: node scripts/merge.mjs <branch>
// Squash-merges branch onto main via push → gh pr create → gh pr merge --auto.
// ADR 0026: receipt check removed; CI rubric-gate is now the authority.
// cwd = caller's dir (main worktree); script location (dirname) is NOT used.
// Landing strategy (ADR 0026 §1-2): push → gh pr create → gh pr merge --auto --squash.
// First commit message → PR title/body. CI gate runs on PR head sha.
// Pure logic is exported for unit testing.

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import process from 'node:process';
// --- Pure / testable exports ---

/**
 * Parse `git rev-list` output into an array of SHAs.
 * Trims each line and filters empties.
 * @param {string} output
 * @returns {string[]}
 */
export function parseRevList(output) {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Reset working tree after a failed squash merge (git merge --squash has no MERGE_HEAD).
 * @param {string} cwd */
export function cleanupFailedSquash(cwd) {
  spawnSync('git', ['reset', '--hard', 'HEAD'], {
    cwd,
    env: { ...process.env, LATHE_MERGE: '1' },
  });
}

/** First commit message from `git log --reverse --format=%B%x00` (NUL-separated records).
 * @param {string} logOutput @returns {string} */
export function extractFirstCommitMessage(logOutput) {
  return logOutput.split('\0')[0].trim();
}

/** subject = first line; body = rest (falls back to subject when subject-only).
 * @param {string} msg @returns {{subject:string,body:string}} */
export function splitCommitMessage(msg) {
  const lines = (msg ?? '').split('\n');
  const subject = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').trim();
  return { subject, body: body || subject };
}

/** @param {{base:string,head:string,title:string,body:string}} p @returns {string[]} */
export function buildPrCreateArgs({ base, head, title, body }) {
  return ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body];
}

/** @param {{branch:string}} p @returns {string[]} argv for gh pr merge --auto --squash */
export function buildPrMergeArgs({ branch }) {
  return ['pr', 'merge', branch, '--auto', '--squash'];
}

/** @param {{branch:string}} p @returns {string[]} argv for gh pr checks --watch (blocks until done) */
export function buildPrChecksWatchArgs({ branch }) {
  return ['pr', 'checks', branch, '--watch'];
}

/** @param {{branch:string}} p @returns {string[]} argv for gh pr merge --squash (no --auto, after CI green) */
export function buildPrMergeFallbackArgs({ branch }) {
  return ['pr', 'merge', branch, '--squash'];
}

/** True if gh output indicates checks are not yet registered (race after gh pr create).
 * @param {{stdout?:string,stderr?:string}} p @returns {boolean} */
export function checksNotRegistered({ stdout = '', stderr = '' }) {
  return /no checks reported/i.test(`${stdout}${stderr}`);
}

/** argv for `gh pr review <branch> --comment --body-file <file>` (non-blocking record).
 * @param {{branch:string, bodyFile:string}} p @returns {string[]} */
export function buildPrReviewArgs({ branch, bodyFile }) {
  return ['pr', 'review', branch, '--comment', '--body-file', bodyFile];
}

/** argv for `gh pr checks <branch>` without --watch (for polling).
 * @param {{branch:string}} p @returns {string[]} */
export function buildPrChecksArgs({ branch }) {
  return ['pr', 'checks', branch];
}

/** Poll until ≥1 CI check appears on the PR; avoids the no-checks race after gh pr create.
 * runChecks/sleep injected for testability. intervalMs×maxAttempts ≈ 120s upper bound.
 * @returns {Promise<{registered:boolean,timedOut?:boolean}>} */
export async function waitForChecksRegistered({
  runChecks, sleep, intervalMs = 5000, maxAttempts = 24, log = () => {},
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = runChecks();
    if (!checksNotRegistered({ stdout: result.stdout, stderr: result.stderr })) return { registered: true };
    log(`merge: checks not yet registered (attempt ${attempt + 1}/${maxAttempts}) — retrying in ${intervalMs}ms`);
    await sleep(intervalMs);
  }
  return { registered: false, timedOut: true };
}

/**
 * Pure function: decide what to do with a PID lock file.
 *
 * Mirrors the ingest incremental lock semantics:
 * - no file => acquire
 * - self PID => acquire/re-enter
 * - live other positive PID => skip/wait
 * - dead, zero, or unreadable PID => reclaim
 *
 * @param {{ exists: boolean, holderPid: number, holderAlive: boolean, selfPid: number }} p
 * @returns {'acquire' | 'skip' | 'reclaim'}
 */
export function decideLock({ exists, holderPid, holderAlive, selfPid }) {
  if (!exists) return 'acquire';
  if (!Number.isNaN(holderPid) && holderPid === selfPid) return 'acquire';
  if (!Number.isNaN(holderPid) && holderPid > 0 && holderAlive) return 'skip';
  return 'reclaim';
}

export function resolveMergeLockPath(cwd) {
  const commonDir = execSync('git rev-parse --git-common-dir', {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LATHE_MERGE: '1' },
  }).trim();
  const gitDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  return join(gitDir, 'lathe-merge.lock');
}

// --- CLI helpers (side-effectful) ---

// git() uses process.cwd() implicitly (execSync default), which is main
// when merge.mjs is invoked from main. This is intentional — git operations
// (push, diff, log) reference the main worktree's remote config.
function git(args, env = {}) {
  return execSync(`git ${args}`, {
    encoding: 'utf8',
    env: { ...process.env, LATHE_MERGE: '1', ...env },
  }).trim();
}

function die(msg) {
  process.stderr.write(`merge: error: ${msg}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath) {
  try {
    return parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
  } catch {
    return NaN;
  }
}

async function acquireMergeLock(lockPath, { retryMs = 1000, log = (msg) => process.stdout.write(msg) } = {}) {
  let waitingFor = null;
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      if (waitingFor !== null) {
        log(`merge: acquired landing lock after waiting for pid ${waitingFor}\n`);
      }
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }

    const holderPid = readLockPid(lockPath);
    const decision = decideLock({
      exists: true,
      holderPid,
      holderAlive: isAlive(holderPid),
      selfPid: process.pid,
    });

    if (decision === 'skip') {
      if (waitingFor !== holderPid) {
        log(`merge: waiting for landing lock held by pid ${holderPid}\n`);
        waitingFor = holderPid;
      }
      await sleep(retryMs);
      continue;
    }

    if (decision === 'reclaim') {
      log(`merge: stale landing lock (pid ${Number.isNaN(holderPid) ? '?' : holderPid}) — reclaiming\n`);
    }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function releaseMergeLock(lockPath) {
  const holderPid = readLockPid(lockPath);
  if (holderPid !== process.pid) return;
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

// --- CLI entrypoint ---

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const [, , branch] = process.argv;

  if (!branch) {
    die('usage: node scripts/merge.mjs <branch>');
  }

  // cwd = where merge.mjs was invoked (should be main worktree).
  // Git operations (push, diff, log) use this as the repo root.
  const cwd = process.cwd();

  let mergeLockPath;
  try {
    mergeLockPath = resolveMergeLockPath(cwd);
    await acquireMergeLock(mergeLockPath);
    process.on('exit', () => releaseMergeLock(mergeLockPath));
  } catch (e) {
    die(`could not acquire landing lock: ${e.message}`);
  }

  // 1. Determine commit range
  let base;
  try {
    base = git(`merge-base main ${branch}`);
  } catch (e) {
    die(`could not determine merge-base: ${e.message}`);
  }

  let revListOutput;
  try {
    revListOutput = git(`rev-list ${base}..${branch}`);
  } catch (e) {
    die(`could not list commits: ${e.message}`);
  }

  const shas = parseRevList(revListOutput);
  if (shas.length === 0) {
    die(`no commits found between main and ${branch} — nothing to merge`);
  }

  // 2. (Receipt check removed — ADR 0026 §1-3. CI rubric-gate is now the authority.)

  // 3. Backstop gate — spawnSync with array args so each path is a separate argv element
  //    (preflight.mjs pattern: spawnSync('node', ['rubrics/run.mjs', '--changed', ...paths, '--tier', tier]))
  let changedPaths;
  try {
    changedPaths = git(`diff --name-only ${base}..${branch}`);
  } catch (e) {
    die(`could not get changed paths: ${e.message}`);
  }

  const paths = changedPaths.trim().split('\n').filter(Boolean);
  if (paths.length > 0) {
    // run.mjs is resolved from cwd (main), not from the script file location,
    // so that `node <worktree>/scripts/merge.mjs` invoked from main still finds
    // main's rubrics/run.mjs.
    const runMjs = join(cwd, 'rubrics', 'run.mjs');
    const result = spawnSync(
      'node',
      ['--', runMjs, '--changed', ...paths, '--tier', 'test'],
      {
        stdio: 'inherit',
        cwd,
        env: { ...process.env, LATHE_MERGE: '1' },
      },
    );
    if (result.status !== 0) {
      die('backstop verify RED — run.mjs --tier test failed');
    }
  }

  // 4. Push branch and open PR with auto-merge (ADR 0026 §1-2).
  //    The first commit's message becomes the PR title (subject) and body, so
  //    review-fix commits don't pollute the PR title. Actual squash happens in CI.
  let firstCommitMsg;
  try {
    // --format=%B%x00: NUL-separated so multi-paragraph bodies / trailers don't
    // collide with the inter-commit separator.
    const logOutput = git(`log --reverse --format=%B%x00 ${base}..${branch}`);
    firstCommitMsg = extractFirstCommitMessage(logOutput);
  } catch (e) {
    die(`could not read commit message: ${e.message}`);
  }
  const { subject, body: prBody } = splitCommitMessage(firstCommitMsg);

  // 4a. Push branch to remote
  const pushResult = spawnSync(
    'git',
    ['push', '-u', 'origin', branch],
    {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    },
  );
  if (pushResult.status !== 0) {
    die(`git push failed — cannot create PR for ${branch}`);
  }

  // 4b. Create PR (base=main, head=branch)
  const prCreateArgs = buildPrCreateArgs({ base: 'main', head: branch, title: subject, body: prBody });
  const prCreateResult = spawnSync('gh', prCreateArgs, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, LATHE_MERGE: '1' },
  });
  if (prCreateResult.status !== 0) {
    die(`gh pr create failed for ${branch}`);
  }

  // 4b-post. Post reviewer verdict as PR review comment (ADR 0028: non-blocking, record purpose).
  const reviewBodyFile = process.env.LATHE_REVIEW_BODY_FILE;
  if (reviewBodyFile) {
    const prReviewResult = spawnSync('gh', buildPrReviewArgs({ branch, bodyFile: reviewBodyFile }), {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    });
    if (prReviewResult.status !== 0) {
      process.stdout.write(`merge: warning: gh pr review --comment failed for ${branch} (non-fatal)\n`);
    }
  }

  // 4c. Arm auto-merge (squash) — primary: --auto (works when branch protection is enabled).
  //     Fallback: when --auto cannot be armed (branch protection disabled), wait for CI
  //     checks to complete via `gh pr checks --watch`, then merge directly without --auto.
  //     Gate is preserved: fallback merge only runs after CI green (checks exit 0).
  const prMergeArgs = buildPrMergeArgs({ branch });
  const prMergeResult = spawnSync('gh', prMergeArgs, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, LATHE_MERGE: '1' },
  });
  if (prMergeResult.status !== 0) {
    // --auto failed (branch protection disabled) — fall back to checks-then-merge.
    // CI gate preserved: refuse if checks non-zero; merge only after CI green.
    process.stdout.write(`merge: --auto not available for ${branch} — falling back to checks-then-merge\n`);

    // Wait for checks to be registered before --watch (race: CI not triggered immediately after gh pr create).
    const waitResult = await waitForChecksRegistered({
      runChecks: () => spawnSync('gh', buildPrChecksArgs({ branch }), { encoding: 'utf8', cwd, env: { ...process.env, LATHE_MERGE: '1' } }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (msg) => process.stdout.write(`${msg}\n`),
    });
    if (waitResult.timedOut) die(`CI checks not registered for ${branch} within wait window — refusing to merge`);

    const checksArgs = buildPrChecksWatchArgs({ branch });
    const checksResult = spawnSync('gh', checksArgs, {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    });
    if (checksResult.status !== 0) {
      die(`CI checks failed for ${branch} — refusing to merge`);
    }

    // CI is green — merge directly (no --auto, branch protection not required).
    const fallbackArgs = buildPrMergeFallbackArgs({ branch });
    const fallbackResult = spawnSync('gh', fallbackArgs, {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    });
    if (fallbackResult.status !== 0) {
      die(`gh pr merge (fallback) failed for ${branch}`);
    }
  }

  process.stdout.write(`merge: done — PR created for ${branch} (${shas.length} commit(s)), auto-merge (squash) armed. CI gate will complete the landing.\n`);
  process.exit(0);
}
