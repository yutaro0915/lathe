#!/usr/bin/env node
// CLI: node scripts/receipt.mjs <step> <sha> <verdict>
// Writes <git-common-dir>/lathe-receipts/<sha>.<step>.json receipt file.
//
// Receipt storage: git common-dir (git rev-parse --git-common-dir).
// Worktrees and main share the same common-dir, so receipts written in a
// worktree are visible to merge.mjs running from main — no path mismatch.
//
// Pure logic is exported for unit testing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const VALID_STEPS = ['review', 'verify'];
const VALID_VERDICTS = {
  review: ['PASS', 'CHANGES'],
  verify: ['GREEN', 'RED'],
};

// --- Pure / testable exports ---

/**
 * Resolve the shared receipts directory using the git common-dir.
 * Both the main worktree and linked worktrees share the same common-dir
 * (typically the .git directory of the main worktree), so receipts written
 * from any worktree are visible everywhere.
 *
 * @param {string} [cwd=process.cwd()] working directory to resolve from
 * @returns {string} absolute path to <git-common-dir>/lathe-receipts
 */
export function resolveReceiptsDir(cwd = process.cwd()) {
  const common = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8' },
  ).trim();
  return join(common, 'lathe-receipts');
}

/**
 * Validate CLI arguments.
 * @param {string} step
 * @param {string} sha
 * @param {string} verdict
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateArgs(step, sha, verdict) {
  if (!VALID_STEPS.includes(step)) {
    return { ok: false, error: `invalid step "${step}": must be one of ${VALID_STEPS.join(', ')}` };
  }
  if (!sha || sha.trim() === '') {
    return { ok: false, error: 'sha must not be empty' };
  }
  const allowed = VALID_VERDICTS[step];
  if (!allowed.includes(verdict)) {
    return {
      ok: false,
      error: `invalid verdict "${verdict}" for step "${step}": must be one of ${allowed.join(', ')}`,
    };
  }
  return { ok: true };
}

/**
 * Build the absolute path for a receipt file.
 * @param {string} receiptsDir  absolute path to the receipts directory (from resolveReceiptsDir)
 * @param {string} sha
 * @param {string} step
 * @returns {string}
 */
export function buildReceiptPath(receiptsDir, sha, step) {
  return join(receiptsDir, `${sha}.${step}.json`);
}

/**
 * Build the receipt JSON object.
 * @param {string} step
 * @param {string} sha
 * @param {string} verdict
 * @param {string} agent
 * @param {string} ts  ISO timestamp string
 * @returns {object}
 */
export function buildReceiptJson(step, sha, verdict, agent, ts) {
  return { step, sha, verdict, ts, agent };
}

// --- CLI entrypoint ---

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const [, , step, sha, verdict] = process.argv;

  const validation = validateArgs(step, sha, verdict);
  if (!validation.ok) {
    process.stderr.write(`receipt: error: ${validation.error}\n`);
    process.stderr.write(
      'usage: node scripts/receipt.mjs <step> <sha> <verdict>\n' +
        '  step    : review | verify\n' +
        '  sha     : commit SHA\n' +
        '  verdict : review→PASS|CHANGES  verify→GREEN|RED\n',
    );
    process.exit(1);
  }

  // Resolve receipts dir from git common-dir (shared across all worktrees)
  let receiptsDir;
  try {
    receiptsDir = resolveReceiptsDir(process.cwd());
  } catch (e) {
    process.stderr.write(`receipt: error: could not resolve git common-dir: ${e.message}\n`);
    process.exit(1);
  }

  const agent = process.env.LATHE_AGENT ?? 'unknown';
  const ts = new Date().toISOString();

  const receiptPath = buildReceiptPath(receiptsDir, sha, step);
  const receiptData = buildReceiptJson(step, sha, verdict, agent, ts);

  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receiptData, null, 2) + '\n', 'utf8');

  process.stdout.write(`receipt written: ${receiptPath}\n`);
  process.exit(0);
}
