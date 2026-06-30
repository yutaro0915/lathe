#!/usr/bin/env node
// CLI: node scripts/merge.mjs <branch>
// Enforces review+verify receipts for the branch tip (HEAD sha) before
// cherry-picking onto main.
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
// Pure logic is exported for unit testing.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
 * @param {string} receiptsDir  absolute path to .lathe/receipts/
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

// --- CLI helpers (side-effectful) ---

// git() uses process.cwd() implicitly (execSync default), which is main
// when merge.mjs is invoked from main. This is intentional — cherry-pick
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
  // All git operations run here so cherry-pick lands on main.
  const cwd = process.cwd();

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

  // 4. cherry-pick
  try {
    execSync(`git cherry-pick ${base}..${branch}`, {
      stdio: 'inherit',
      env: { ...process.env, LATHE_MERGE: '1' },
    });
  } catch {
    // Abort on conflict
    try {
      execSync('git cherry-pick --abort', {
        env: { ...process.env, LATHE_MERGE: '1' },
      });
    } catch {
      // ignore abort errors
    }
    die('cherry-pick failed (conflict) — aborted. Resolve conflicts and retry.');
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

  process.stdout.write(`merge: done — ${shas.length} commit(s) cherry-picked onto main.\n`);
  process.exit(0);
}
