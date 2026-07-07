#!/usr/bin/env node
// CLI: node scripts/inner-queue.mjs [--max K] [--max-failures N] [--dry-run]
//
// Dependency-aware dispatcher for the inner-loop driver. After ADR 0031
// (issues as task substrate) the queue is wired to GitHub: it lists open
// `task-request` issues (issue = task, TASK-N = issue #N), derives readiness
// from the `blocked-by #N` body notation (a task is ready when every
// referenced issue is closed), derives "In Progress" from open PRs that
// reference the issue (`Closes #N` body ref or `inner/issue-<n>` head
// branch — ADR 0031 §2: state is derived, never stored), skips locally
// running tasks (inner-issue-<n> worktree present), and starts
// non-overlapping tasks through `node scripts/inner-loop.mjs <issue#>`.
// Issues carrying the `escalation` label are 裁定 loop material, not driver
// work, and are skipped (ADR 0030 追記 E).
//
// The old Backlog.md wiring (`backlog task list/view`, `backlog sequence
// list`) is gone — its substrate was deleted in PR #146 (ADR 0031 §3).
//
// Pure decision helpers live in inner-queue-decisions.mjs (re-exported here
// so tests keep one import surface); this file holds the gh/git/spawn side
// effects and the CLI.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { parseBlockedBy, issueLabelNames, TASK_REQUEST_LABEL } from './inner-loop-core.mjs';
import {
  planDryRun, runQueue, formatDecision,
  deriveReadyTaskIds, deriveInProgressIssueNumbers, parseInnerIssueWorktrees,
} from './inner-queue-decisions.mjs';

export * from './inner-queue-decisions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ISSUE_LIST_LIMIT = 200;

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
    maxBuffer: 1e8,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

// List open task-request issues (issue = task). Shape: { id, title, body, labels }.
function fetchQueueTasks() {
  const issues = ghJson(['issue', 'list', '--label', TASK_REQUEST_LABEL, '--state', 'open',
    '--json', 'number,title,body,labels', '--limit', String(ISSUE_LIST_LIMIT)]);
  return issues.map((issue) => ({
    id: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    labels: issueLabelNames(issue),
  }));
}

// Resolve blocked-by readiness: refs inside the open task list are open by
// construction; refs outside it are looked up once each (issue state only).
function fetchReadyTaskIds(tasks) {
  const openNumbers = new Set(tasks.map((task) => task.id));
  const outsideRefs = new Set();
  for (const task of tasks) {
    for (const ref of parseBlockedBy(task.body)) {
      if (!openNumbers.has(ref)) outsideRefs.add(ref);
    }
  }
  const openRefs = new Set(openNumbers);
  for (const ref of outsideRefs) {
    const issue = ghJson(['issue', 'view', String(ref), '--json', 'state']);
    if (String(issue?.state ?? '').toUpperCase() === 'OPEN') openRefs.add(ref);
  }
  return deriveReadyTaskIds(tasks, openRefs);
}

function fetchInProgressIssueNumbers() {
  const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,body,headRefName', '--limit', String(ISSUE_LIST_LIMIT)]);
  return deriveInProgressIssueNumbers(prs);
}

function fetchIssueState(issueNumber) {
  return String(ghJson(['issue', 'view', String(issueNumber), '--json', 'state'])?.state ?? 'UNKNOWN').toUpperCase();
}

function detectRunningWorktrees(tasks) {
  const running = new Map();
  const taskIds = new Set(tasks.map((task) => task.id));

  const listResult = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (listResult.status === 0) {
    for (const [issueNumber, worktreePath] of parseInnerIssueWorktrees(listResult.stdout)) {
      if (taskIds.has(issueNumber)) running.set(issueNumber, worktreePath);
    }
  }

  for (const task of tasks) {
    const p = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${task.id}`);
    if (existsSync(p)) running.set(task.id, p);
  }
  return running;
}

export function buildInnerLoopSpawnSpec(task, logFd) {
  return {
    command: process.execPath,
    args: ['scripts/inner-loop.mjs', String(task.id)],
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

export async function spawnInnerLoop(task, {
  checkState = fetchIssueState,
  spawnChild = spawn,
  log = (line) => process.stdout.write(`${line}\n`),
  logRoot = join(REPO_ROOT, '.lathe', 'runs'),
  now = () => new Date(),
} = {}) {
  const logPath = join(logRoot, `issue-${task.id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  let state;
  try {
    state = String(await checkState(task.id) ?? 'UNKNOWN');
  } catch (error) {
    appendQueueLog(logPath, `[inner-queue] state check error before issue #${task.id}: ${error.message}`);
    return { status: 1 };
  }

  if (state !== 'OPEN') {
    const line = `SKIP_NOT_OPEN #${task.id} (state=${state} at dispatch)`;
    log(line);
    appendQueueLog(logPath, `[inner-queue] ${line}`);
    return { status: 0 };
  }

  return new Promise((resolve) => {
    appendQueueLog(logPath, `[inner-queue] start issue #${task.id} at ${now().toISOString()}`);

    const logFd = openSync(logPath, 'a');
    const spec = buildInnerLoopSpawnSpec(task, logFd);
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
      appendQueueLog(logPath, `\n[inner-queue] done issue #${task.id} status=${code ?? 'null'} signal=${signal ?? 'null'} at ${now().toISOString()}`);
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

  let tasks;
  let readyTaskIds;
  let inProgressIssueNumbers;
  try {
    tasks = fetchQueueTasks();
    readyTaskIds = fetchReadyTaskIds(tasks);
    inProgressIssueNumbers = fetchInProgressIssueNumbers();
  } catch (e) {
    die(e.message);
  }
  const runningWorktrees = detectRunningWorktrees(tasks);

  if (parsed.dryRun) {
    const decisions = planDryRun({
      tasks,
      readyTaskIds,
      runningWorktrees,
      inProgressIssueNumbers,
      max: parsed.max,
    });
    for (const decision of decisions) {
      process.stdout.write(`${formatDecision(decision)}\n`);
    }
    process.exit(0);
  }

  const result = await runQueue({
    tasks,
    readyTaskIds,
    runningWorktrees,
    inProgressIssueNumbers,
    max: parsed.max,
    maxFailures: parsed.maxFailures,
    spawnTask: spawnInnerLoop,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  process.exit(result.failed === 0 ? 0 : 1);
}
