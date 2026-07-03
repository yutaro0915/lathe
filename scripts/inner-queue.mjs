#!/usr/bin/env node
// CLI: node scripts/inner-queue.mjs [--max K] [--max-failures N] [--dry-run]
//
// Dependency-aware dispatcher for ADR 0015. It lists open GitHub issues labeled
// `inner-loop`, skips unresolved dependencies / already-running issues, and
// starts non-overlapping issues through scripts/inner-loop.mjs.
//
// Pure decision helpers are exported for unit tests.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const READY_NOW = 'READY_NOW';
export const WAIT_DEP = 'WAIT_DEP';
export const SKIP_RUNNING = 'SKIP_RUNNING';
export const DEFER_TOUCHES = 'DEFER_TOUCHES';
export const DEFER_CAPACITY = 'DEFER_CAPACITY';

/**
 * Parse machine-readable inner-loop hints from an issue body.
 *
 * Supported lines:
 *   Depends-on: #29, #35
 *   Touches: scripts/inner-loop.mjs, apps/web/lib/
 *
 * Matching is line-oriented and case-insensitive. Duplicate dependency numbers
 * and touch paths are de-duped while preserving first-seen order.
 *
 * @param {string | null | undefined} body
 * @returns {{ dependsOn: number[], touches: string[] }}
 */
export function parseIssueRunHints(body) {
  const dependsOn = [];
  const touches = [];
  const seenDeps = new Set();
  const seenTouches = new Set();
  const text = typeof body === 'string' ? body : '';

  for (const line of text.split(/\r?\n/)) {
    const depMatch = line.match(/^\s*depends-on\s*:\s*(.*)$/i);
    if (depMatch) {
      for (const match of depMatch[1].matchAll(/#(\d+)/g)) {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n > 0 && !seenDeps.has(n)) {
          seenDeps.add(n);
          dependsOn.push(n);
        }
      }
      continue;
    }

    const touchesMatch = line.match(/^\s*touches\s*:\s*(.*)$/i);
    if (touchesMatch) {
      for (const raw of touchesMatch[1].split(',')) {
        const p = raw.trim();
        if (p.length > 0 && !seenTouches.has(p)) {
          seenTouches.add(p);
          touches.push(p);
        }
      }
    }
  }

  return { dependsOn, touches };
}

function normalizeTouchPath(p) {
  const raw = String(p ?? '').trim().replaceAll('\\', '/');
  if (!raw) return '';
  let normalized = posix.normalize(raw);
  normalized = normalized.replace(/^(\.\/)+/, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * Returns true when two declared Touches paths overlap. Overlap is exact match
 * or parent/child relationship at path segment boundaries.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function pathsOverlap(a, b) {
  const left = normalizeTouchPath(a);
  const right = normalizeTouchPath(b);
  if (!left || !right) return false;
  if (left === '.' || right === '.') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function enrichIssue(issue) {
  return {
    ...issue,
    hints: issue.hints ?? parseIssueRunHints(issue.body ?? ''),
  };
}

function runningWorktreeFor(runningWorktrees, issueNumber) {
  if (!runningWorktrees) return null;
  if (runningWorktrees instanceof Map) return runningWorktrees.get(issueNumber) ?? null;
  if (runningWorktrees instanceof Set) return runningWorktrees.has(issueNumber) ? true : null;
  return runningWorktrees[issueNumber] ?? null;
}

function dependencyStateFor(dependencyStates, issueNumber) {
  if (!dependencyStates) return undefined;
  if (dependencyStates instanceof Map) return dependencyStates.get(issueNumber);
  return dependencyStates[issueNumber];
}

function unresolvedDependencies(issue, dependencyStates) {
  const enriched = enrichIssue(issue);
  return enriched.hints.dependsOn.filter((n) => dependencyStateFor(dependencyStates, n) !== 'CLOSED');
}

function firstTouchOverlap(issue, activeIssues) {
  const candidate = enrichIssue(issue);
  if (candidate.hints.touches.length === 0) return null;
  for (const active of activeIssues ?? []) {
    const blocker = enrichIssue(active);
    if (blocker.number === candidate.number || blocker.hints.touches.length === 0) continue;
    for (const cPath of candidate.hints.touches) {
      for (const bPath of blocker.hints.touches) {
        if (pathsOverlap(cPath, bPath)) {
          return { issueNumber: blocker.number, path: cPath };
        }
      }
    }
  }
  return null;
}

/**
 * Classify one issue against dependency state, running worktrees, active issue
 * touches, and capacity.
 *
 * @param {{ issue: object, dependencyStates?: Map<number,string>|Record<string,string>, runningWorktrees?: Map<number,string>|Set<number>|Record<string,string>, activeIssues?: object[], activeSlots?: number, max?: number }} p
 */
export function classifyIssue({
  issue,
  dependencyStates = new Map(),
  runningWorktrees = new Map(),
  activeIssues = [],
  activeSlots = 0,
  max = Number.POSITIVE_INFINITY,
}) {
  const enriched = enrichIssue(issue);
  const worktree = runningWorktreeFor(runningWorktrees, enriched.number);
  if (worktree) {
    return { status: SKIP_RUNNING, issue: enriched, worktree };
  }

  const unresolved = unresolvedDependencies(enriched, dependencyStates);
  if (unresolved.length > 0) {
    return { status: WAIT_DEP, issue: enriched, unresolved };
  }

  const overlap = firstTouchOverlap(enriched, activeIssues);
  if (overlap) {
    return { status: DEFER_TOUCHES, issue: enriched, overlaps: overlap.issueNumber, path: overlap.path };
  }

  if (activeSlots >= max) {
    return { status: DEFER_CAPACITY, issue: enriched, max };
  }

  return { status: READY_NOW, issue: enriched };
}

/**
 * Build deterministic dry-run decisions. Issues are processed in ascending issue
 * number, so lower-numbered ready issues reserve capacity/touches first.
 *
 * @param {{ issues: object[], dependencyStates?: Map<number,string>|Record<string,string>, runningWorktrees?: Map<number,string>|Set<number>|Record<string,string>, max?: number }} p
 */
export function planDryRun({
  issues,
  dependencyStates = new Map(),
  runningWorktrees = new Map(),
  max = 2,
}) {
  const enrichedIssues = [...issues].map(enrichIssue).sort((a, b) => a.number - b.number);
  const runningIssues = enrichedIssues.filter((issue) => runningWorktreeFor(runningWorktrees, issue.number));
  const selected = [];
  const decisions = [];

  for (const issue of enrichedIssues) {
    const activeIssues = [...runningIssues, ...selected];
    const decision = classifyIssue({
      issue,
      dependencyStates,
      runningWorktrees,
      activeIssues,
      activeSlots: activeIssues.length,
      max,
    });
    decisions.push(decision);
    if (decision.status === READY_NOW) selected.push(issue);
  }

  return decisions;
}

/**
 * Run the live queue with injected side effects. `spawnIssue` must return a
 * promise resolving to { status }. Touch conflicts against queue-launched active
 * issues are re-evaluated after each completion.
 *
 * @param {{ issues: object[], dependencyStates?: Map<number,string>|Record<string,string>, runningWorktrees?: Map<number,string>|Set<number>|Record<string,string>, max?: number, maxFailures?: number, spawnIssue: (issue: object) => Promise<{status:number|null}>, log?: (line:string)=>void }} p
 */
export async function runQueue({
  issues,
  dependencyStates = new Map(),
  runningWorktrees = new Map(),
  max = 2,
  maxFailures = 3,
  spawnIssue,
  log = () => {},
}) {
  const pending = [...issues].map(enrichIssue).sort((a, b) => a.number - b.number);
  const allIssues = pending;
  const runningIssues = allIssues.filter((issue) => runningWorktreeFor(runningWorktrees, issue.number));
  /** @type {Array<{ issue: object, promise: Promise<{status:number|null}> }>} */
  const active = [];
  const launched = [];
  const skipped = [];
  let failed = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;

  function removePending(issueNumber) {
    const index = pending.findIndex((issue) => issue.number === issueNumber);
    if (index >= 0) pending.splice(index, 1);
  }

  function hasFailureBudgetForDispatch() {
    return maxFailures === 0 || consecutiveFailures + active.length < maxFailures;
  }

  for (const issue of [...pending]) {
    const decision = classifyIssue({
      issue,
      dependencyStates,
      runningWorktrees,
      activeIssues: runningIssues,
      activeSlots: runningIssues.length,
      max,
    });
    if (decision.status === SKIP_RUNNING || decision.status === WAIT_DEP) {
      log(formatDecision(decision));
      skipped.push(decision);
      removePending(issue.number);
    }
  }

  while ((pending.length > 0 && !circuitOpen) || active.length > 0) {
    let madeProgress = false;

    while (
      !circuitOpen &&
      pending.length > 0 &&
      runningIssues.length + active.length < max &&
      hasFailureBudgetForDispatch()
    ) {
      const activeIssues = [...runningIssues, ...active.map((entry) => entry.issue)];
      const startIndex = pending.findIndex((issue) => (
        classifyIssue({
          issue,
          dependencyStates,
          runningWorktrees,
          activeIssues,
          activeSlots: runningIssues.length + active.length,
          max,
        }).status === READY_NOW
      ));

      if (startIndex < 0) break;

      const [issue] = pending.splice(startIndex, 1);
      const decision = { status: READY_NOW, issue };
      log(formatDecision(decision));
      launched.push(issue.number);
      const promise = Promise.resolve()
        .then(() => spawnIssue(issue))
        .catch((error) => {
          return { status: 1, error };
        });
      active.push({ issue, promise });
      madeProgress = true;
    }

    if (active.length > 0) {
      const settled = await Promise.race(
        active.map((entry, index) => entry.promise.then((result) => ({ index, result }))),
      );
      const [done] = active.splice(settled.index, 1);
      const status = settled.result?.status ?? 1;
      log(`DONE #${done.issue.number} status=${status}`);
      if (status === 0) {
        consecutiveFailures = 0;
      } else {
        failed += 1;
        consecutiveFailures += 1;
        if (!circuitOpen && maxFailures > 0 && consecutiveFailures >= maxFailures) {
          circuitOpen = true;
          log(`CIRCUIT_OPEN after ${maxFailures} consecutive failures — dispatch halted`);
        }
      }
      continue;
    }

    if (!madeProgress && pending.length > 0) {
      for (const issue of pending.splice(0)) {
        const decision = classifyIssue({
          issue,
          dependencyStates,
          runningWorktrees,
          activeIssues: runningIssues,
          activeSlots: runningIssues.length,
          max,
        });
        log(formatDecision(decision));
        skipped.push(decision);
      }
    }
  }

  return { launched, skipped, failed };
}

export function formatDecision(decision) {
  const n = decision.issue.number;
  switch (decision.status) {
    case READY_NOW:
      return `${READY_NOW} #${n}`;
    case WAIT_DEP:
      return `${WAIT_DEP} #${n} unresolved=${decision.unresolved.map((d) => `#${d}`).join(',')}`;
    case DEFER_TOUCHES:
      return `${DEFER_TOUCHES} #${n} overlaps=#${decision.overlaps} path=${decision.path}`;
    case SKIP_RUNNING:
      return `${SKIP_RUNNING} #${n} worktree=${decision.worktree}`;
    case DEFER_CAPACITY:
      return `${DEFER_CAPACITY} #${n} max=${decision.max}`;
    default:
      return `UNKNOWN #${n}`;
  }
}

export function parseInnerIssueWorktrees(worktreeListOutput) {
  const running = new Map();
  for (const line of String(worktreeListOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/);
    if (!match) continue;
    const worktreePath = match[1].trim();
    const issueMatch = basename(worktreePath).match(/^inner-issue-(\d+)$/);
    if (!issueMatch) continue;
    const issueNumber = Number(issueMatch[1]);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      running.set(issueNumber, worktreePath);
    }
  }
  return running;
}

function parseArgs(argv) {
  let max = 2;
  let maxFailures = 3;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--max') {
      max = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--max=')) {
      max = Number(arg.slice('--max='.length));
    } else if (arg === '--max-failures') {
      maxFailures = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--max-failures=')) {
      maxFailures = Number(arg.slice('--max-failures='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error('--max must be a positive integer');
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 0) {
    throw new Error('--max-failures must be a non-negative integer');
  }
  return { max, maxFailures, dryRun };
}

function ghJson(args) {
  const result = spawnSync('gh', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function fetchQueueIssues() {
  return ghJson([
    'issue', 'list',
    '--label', 'inner-loop',
    '--state', 'open',
    '--json', 'number,title,body',
    '--limit', '100',
  ]);
}

function fetchDependencyStates(issues) {
  const deps = new Set();
  for (const issue of issues) {
    for (const n of parseIssueRunHints(issue.body ?? '').dependsOn) deps.add(n);
  }

  const states = new Map();
  for (const n of deps) {
    try {
      const data = ghJson(['issue', 'view', String(n), '--json', 'number,state']);
      states.set(n, data.state);
    } catch (e) {
      process.stderr.write(`inner-queue: warning: dependency #${n} state unknown: ${e.message}\n`);
    }
  }
  return states;
}

function fetchIssueState(issueNumber) {
  const data = ghJson(['issue', 'view', String(issueNumber), '--json', 'state']);
  return data.state;
}

function detectRunningWorktrees(issues) {
  const running = new Map();
  const issueNumbers = new Set(issues.map((issue) => issue.number));

  const listResult = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (listResult.status === 0) {
    for (const [issueNumber, worktreePath] of parseInnerIssueWorktrees(listResult.stdout)) {
      if (issueNumbers.has(issueNumber)) running.set(issueNumber, worktreePath);
    }
  }

  for (const issue of issues) {
    const p = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issue.number}`);
    if (existsSync(p)) running.set(issue.number, p);
  }
  return running;
}

export function buildInnerLoopSpawnSpec(issue, logFd) {
  return {
    command: process.execPath,
    args: ['scripts/inner-loop.mjs', String(issue.number)],
    options: {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    },
  };
}

function appendQueueLog(logPath, line) {
  appendFileSync(logPath, `${line}\n`);
}

export async function spawnInnerLoop(issue, {
  checkState = fetchIssueState,
  spawnChild = spawn,
  log = (line) => process.stdout.write(`${line}\n`),
  logRoot = join(REPO_ROOT, '.lathe', 'runs'),
  now = () => new Date(),
} = {}) {
  const logPath = join(logRoot, `issue-${issue.number}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  let state;
  try {
    state = String(await checkState(issue.number) ?? 'UNKNOWN');
  } catch (error) {
    appendQueueLog(logPath, `[inner-queue] state check error before issue #${issue.number}: ${error.message}`);
    return { status: 1 };
  }

  if (state !== 'OPEN') {
    const line = `SKIP_CLOSED #${issue.number} (state=${state} at dispatch)`;
    log(line);
    appendQueueLog(logPath, `[inner-queue] ${line}`);
    return { status: 0 };
  }

  return new Promise((resolve) => {
    appendQueueLog(logPath, `[inner-queue] start issue #${issue.number} at ${now().toISOString()}`);

    const logFd = openSync(logPath, 'a');
    const spec = buildInnerLoopSpawnSpec(issue, logFd);
    let child;
    try {
      child = spawnChild(spec.command, spec.args, spec.options);
    } catch (error) {
      closeSync(logFd);
      appendQueueLog(logPath, `\n[inner-queue] spawn error: ${error.message}`);
      resolve({ status: 1 });
      return;
    }
    closeSync(logFd);

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    child.on('error', (error) => {
      appendQueueLog(logPath, `\n[inner-queue] spawn error: ${error.message}`);
      finish({ status: 1 });
    });
    child.on('close', (code, signal) => {
      appendQueueLog(logPath, `\n[inner-queue] done issue #${issue.number} status=${code ?? 'null'} signal=${signal ?? 'null'} at ${now().toISOString()}`);
      finish({ status: code ?? 1 });
    });
  });
}

function die(msg) {
  process.stderr.write(`inner-queue: error: ${msg}\n`);
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    die(`${e.message}\nusage: node scripts/inner-queue.mjs [--max K] [--max-failures N] [--dry-run]`);
  }

  let issues;
  let dependencyStates;
  try {
    issues = fetchQueueIssues();
    dependencyStates = fetchDependencyStates(issues);
  } catch (e) {
    die(e.message);
  }
  const runningWorktrees = detectRunningWorktrees(issues);

  if (parsed.dryRun) {
    const decisions = planDryRun({
      issues,
      dependencyStates,
      runningWorktrees,
      max: parsed.max,
    });
    for (const decision of decisions) {
      process.stdout.write(`${formatDecision(decision)}\n`);
    }
    process.exit(0);
  }

  const result = await runQueue({
    issues,
    dependencyStates,
    runningWorktrees,
    max: parsed.max,
    maxFailures: parsed.maxFailures,
    spawnIssue: spawnInnerLoop,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  process.exit(result.failed === 0 ? 0 : 1);
}
