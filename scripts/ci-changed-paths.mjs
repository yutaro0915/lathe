#!/usr/bin/env node
// CLI: node scripts/ci-changed-paths.mjs
// Output: changed file paths (one per line) for CI rubric-gate, using proper PR/push diff range.
//
// For pull_request events: base=pull_request.base.sha, head=pull_request.head.sha
// For push events:         base=before, head=after  (avoids same-SHA no-op on main)
// New ref (before=0000…):  fallback to git merge-base main <head>
//
// GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are set automatically by GitHub Actions.
// Falls back to empty output when not in CI — safe for local dev.
//
// Pure logic (deriveDiffRange) is exported for unit testing.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import process from 'node:process';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Derive the base..head range for `git diff --name-only` from a GitHub Actions event payload.
 * Pure and testable — no filesystem or git calls.
 *
 * pull_request: base = pull_request.base.sha, head = pull_request.head.sha
 * push:         base = payload.before, head = payload.after
 *   New-ref push (before is all-zeros): returns the sentinel {base:'__merge-base-main__', head}
 *   and the CLI resolves it via `git merge-base main <head>`.
 *
 * @param {string} eventName  - 'pull_request' | 'push' | other
 * @param {object} payload    - parsed JSON event payload
 * @returns {{ base: string, head: string } | null}  null if unsupported or incomplete
 */
export function deriveDiffRange(eventName, payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (eventName === 'pull_request') {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    if (typeof base !== 'string' || !base) return null;
    if (typeof head !== 'string' || !head) return null;
    return { base, head };
  }

  if (eventName === 'push') {
    const before = payload.before;
    const after = payload.after;
    if (typeof after !== 'string' || !after) return null;
    // New-ref push: before is all zeros or missing — fall back to merge-base
    if (!before || before === ZERO_SHA) {
      return { base: '__merge-base-main__', head: after };
    }
    return { base: before, head: after };
  }

  return null;
}

// --- CLI ---

const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const eventPath = process.env.GITHUB_EVENT_PATH ?? '';

if (!eventName || !eventPath) {
  // Not in CI — emit nothing (safe fallback for local dev)
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(eventPath, 'utf8'));
} catch (e) {
  process.stderr.write(`ci-changed-paths: failed to read event payload at ${eventPath}: ${e.message}\n`);
  process.exit(1);
}

const range = deriveDiffRange(eventName, payload);
if (!range) {
  // Unsupported event or incomplete payload — emit nothing
  process.exit(0);
}

let base = range.base;
const head = range.head;

if (base === '__merge-base-main__') {
  try {
    base = execSync(`git merge-base main ${head}`, { encoding: 'utf8' }).trim();
  } catch {
    // Cannot determine merge-base (e.g. shallow clone with no common ancestor) — emit nothing
    process.exit(0);
  }
}

try {
  const result = execSync(`git diff --name-only ${base}..${head}`, { encoding: 'utf8' });
  process.stdout.write(result);
} catch (e) {
  process.stderr.write(`ci-changed-paths: git diff failed: ${e.message}\n`);
  process.exit(1);
}
