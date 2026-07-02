#!/usr/bin/env node
// CLI: node scripts/merge.mjs <branch>
// Enforces review+verify receipts for the branch tip (HEAD sha) before
// squash-merging onto main.
//
// Receipt unit: the branch tip sha (git rev-parse <branch>).
// reviewer/verifier see the full branch diff, not individual commits, so
// receipts are issued against HEAD and checked against HEAD.
//
// Receipt storage: shared git common-dir (via resolveReceiptsDir from receipt.mjs).
// This means receipts written in a worktree are visible when merge.mjs runs from main.
//
// cwd semantics: merge.mjs uses process.cwd() (the caller's dir — main) for all
// git operations and path resolution. The script file location (dirname) is NOT used
// so that `node <worktree>/scripts/merge.mjs <branch>` run from main still operates
// on main.
//
// Landing strategy: git merge --squash <branch> + git commit with the first commit's
// message (feat subject + body + trailers). This avoids multi-commit tangle and keeps
// main history at 1 slice = 1 commit.
//
// Pure logic is exported for unit testing.

import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolveReceiptsDir } from './receipt.mjs';

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

/**
 * Check that a single sha (the branch tip) has both a PASS review receipt
 * and a GREEN verify receipt inside `receiptsDir`.
 *
 * Receipt unit is the branch tip sha — reviewer/verifier assess the full
 * branch diff (HEAD), not individual commits.
 *
 * @param {string} receiptsDir  absolute path to <git-common-dir>/lathe-receipts
 * @param {string} headSha      the branch tip sha (git rev-parse <branch>)
 * @returns {{ ok: boolean, missing: Array<{sha: string, step: string}> }}
 */
export function checkReceipts(receiptsDir, headSha) {
  /** @type {Array<{sha: string, step: string}>} */
  const missing = [];

  // --- review receipt ---
  const reviewPath = join(receiptsDir, `${headSha}.review.json`);
  if (!existsSync(reviewPath)) {
    missing.push({ sha: headSha, step: 'review' });
  } else {
    try {
      const data = JSON.parse(readFileSync(reviewPath, 'utf8'));
      if (data.verdict !== 'PASS') {
        missing.push({ sha: headSha, step: 'review' });
      }
    } catch {
      missing.push({ sha: headSha, step: 'review' });
    }
  }

  // --- verify receipt ---
  const verifyPath = join(receiptsDir, `${headSha}.verify.json`);
  if (!existsSync(verifyPath)) {
    missing.push({ sha: headSha, step: 'verify' });
  } else {
    try {
      const data = JSON.parse(readFileSync(verifyPath, 'utf8'));
      if (data.verdict !== 'GREEN') {
        missing.push({ sha: headSha, step: 'verify' });
      }
    } catch {
      missing.push({ sha: headSha, step: 'verify' });
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Clean up a failed squash merge by resetting the working tree to HEAD.
 *
 * `git merge --squash` does NOT create MERGE_HEAD, so `git merge --abort`
 * is a no-op and leaves staged auto-merge content and conflict markers in the
 * working tree. `git reset --hard HEAD` removes both staged content and
 * conflict markers by restoring tracked files to HEAD.
 *
 * @param {string} cwd  working directory (the main worktree)
 */
export function cleanupFailedSquash(cwd) {
  spawnSync('git', ['reset', '--hard', 'HEAD'], {
    cwd,
    env: { ...process.env, LATHE_MERGE: '1' },
  });
}

/**
 * Extract the first commit's full message from
 * `git log --reverse --format=%B%x00` output (NUL-separated).
 *
 * Using NUL (`\0`) as the record separator avoids ambiguity with blank lines
 * inside commit bodies (Co-Authored-By trailers, multi-paragraph bodies, etc.).
 * Each commit's %B block is followed by a NUL character.
 *
 * @param {string} logOutput  raw output of `git log --reverse --format=%B%x00 base..branch`
 * @returns {string}          trimmed first commit message
 */
export function extractFirstCommitMessage(logOutput) {
  const parts = logOutput.split('\0');
  // parts[0] is the first commit's body; subsequent parts are other commits or trailing empty
  return parts[0].trim();
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
// when merge.mjs is invoked from main. This is intentional — the squash merge
// must land on main regardless of where merge.mjs script file lives.
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
  // All git operations run here so squash merge lands on main.
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

  // 2. Receipt check — against branch tip sha (HEAD), not individual commits.
  //    reviewer/verifier see the full branch diff, so receipts are issued at HEAD.
  let headSha;
  try {
    headSha = git(`rev-parse ${branch}`);
  } catch (e) {
    die(`could not resolve branch tip sha: ${e.message}`);
  }

  // Receipts live in the shared git common-dir — visible from any worktree or main.
  let receiptsDir;
  try {
    receiptsDir = resolveReceiptsDir(cwd);
  } catch (e) {
    die(`could not resolve git common-dir for receipts: ${e.message}`);
  }
  const { ok: receiptsOk, missing } = checkReceipts(receiptsDir, headSha);

  if (!receiptsOk) {
    const lines = missing.map(({ sha, step }) => `  missing: ${sha}.${step}.json`).join('\n');
    die(
      `receipt check failed — the following receipts are missing or invalid:\n${lines}\n\n` +
        'reviewer / verifier を回して receipt を出してから再実行してください:\n' +
        `  ※ sha は branch tip: ${headSha}\n` +
        '  review:  LATHE_AGENT=reviewer node scripts/receipt.mjs review <sha> <PASS|CHANGES>\n' +
        '  verify:  LATHE_AGENT=verifier node scripts/receipt.mjs verify <sha> <GREEN|RED>',
    );
  }

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

  // 4. Squash merge: stage net diff as a single commit on main.
  //    Use the first commit's message (feat subject + body + trailers) so that
  //    review-fix commits don't pollute the subject line.
  let firstCommitMsg;
  try {
    // --format=%B%x00: NUL-separated so multi-paragraph bodies / trailers don't
    // collide with the inter-commit separator.
    const logOutput = git(`log --reverse --format=%B%x00 ${base}..${branch}`);
    firstCommitMsg = extractFirstCommitMessage(logOutput);
  } catch (e) {
    die(`could not read commit message: ${e.message}`);
  }

  const squashResult = spawnSync(
    'git',
    ['merge', '--squash', branch],
    {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    },
  );
  if (squashResult.status !== 0) {
    // squash merge は MERGE_HEAD を作らないため merge --abort は空振りする。
    // reset --hard HEAD でステージング内容と conflict marker を除去する。
    cleanupFailedSquash(cwd);
    die('squash conflict — working tree を HEAD に戻しました。競合を解消して再実行してください。');
  }

  // Check that there is actually something staged (net diff not empty)
  const stagedResult = spawnSync('git', ['diff', '--cached', '--name-only'], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, LATHE_MERGE: '1' },
  });
  if (!stagedResult.stdout || !stagedResult.stdout.trim()) {
    die(`net diff is empty after squash — nothing to commit from ${branch}`);
  }

  // Commit with the first commit's message
  const commitResult = spawnSync(
    'git',
    ['commit', '-m', firstCommitMsg],
    {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, LATHE_MERGE: '1' },
    },
  );
  if (commitResult.status !== 0) {
    die('git commit failed after squash merge');
  }

  // 5. Clean up consumed receipts (only the head sha receipt)
  for (const step of ['review', 'verify']) {
    const p = join(receiptsDir, `${headSha}.${step}.json`);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        // non-fatal
      }
    }
  }

  process.stdout.write(`merge: done — ${shas.length} commit(s) squash-merged onto main as 1 commit.\n`);
  process.exit(0);
}
