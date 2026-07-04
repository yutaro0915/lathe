#!/usr/bin/env node
// CLI: node scripts/inner-queue.mjs [--max K] [--max-failures N] [--dry-run]
//
// Dependency-aware dispatcher for ADR 0015 / ADR 0025 §4 (TASK-1.3). It lists
// Backlog.md tasks in status "To Do", resolves execution order/parallel
// groups via `backlog sequence list --plain` (task dependency DAG — no more
// self-rolled Depends-on parsing), skips already-running tasks, and starts
// non-overlapping tasks through scripts/inner-loop.mjs --task <ID>.
//
// Pure decision helpers are exported for unit tests.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { parseTaskViewPlain, taskUnitToSlug } from './inner-loop.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BACKLOG_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'backlog');

export const READY_NOW = 'READY_NOW';
export const WAIT_DEP = 'WAIT_DEP';
export const SKIP_RUNNING = 'SKIP_RUNNING';
export const DEFER_TOUCHES = 'DEFER_TOUCHES';
export const DEFER_CAPACITY = 'DEFER_CAPACITY';

/**
 * Parse machine-readable inner-loop hints from a Backlog.md task body
 * (description). Dependency resolution/ordering now comes from
 * `backlog sequence list --plain` (ADR 0025 §4 / TASK-1.3 — no self-rolled
 * DAG), so only Touches survives here (PLAN-gate decision #4: "Touches は
 * 当面 description 行を継続 parse").
 *
 * Supported line:
 *   Touches: scripts/inner-loop.mjs, apps/web/lib/
 *
 * Matching is line-oriented and case-insensitive. Duplicate touch paths are
 * de-duped while preserving first-seen order.
 *
 * @param {string | null | undefined} body
 * @returns {{ touches: string[] }}
 */
export function parseTaskRunHints(body) {
  const touches = [];
  const seenTouches = new Set();
  const text = typeof body === 'string' ? body : '';

  for (const line of text.split(/\r?\n/)) {
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

  return { touches };
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

function enrichTask(task) {
  return {
    ...task,
    hints: task.hints ?? parseTaskRunHints(task.body ?? ''),
  };
}

function runningWorktreeFor(runningWorktrees, taskId) {
  if (!runningWorktrees) return null;
  if (runningWorktrees instanceof Map) return runningWorktrees.get(taskId) ?? null;
  if (runningWorktrees instanceof Set) return runningWorktrees.has(taskId) ? true : null;
  return runningWorktrees[taskId] ?? null;
}

/**
 * A task is dependency-ready when `backlog sequence list --plain` places it
 * in Sequence 1 (no unresolved — i.e. not-yet-Done — dependency). backlog
 * computes the DAG itself (ADR 0025 §4 / TASK-1.3), so the queue only needs
 * membership in that set rather than resolving per-dependency state itself.
 * @param {{ id: string, dependencies?: string[] }} task
 * @param {Set<string>} readyTaskIds
 * @returns {string[]} declared dependency ids, for a WAIT_DEP message, when not ready
 */
function unresolvedDependencies(task, readyTaskIds) {
  if (readyTaskIds instanceof Set && readyTaskIds.has(task.id)) return [];
  return Array.isArray(task.dependencies) ? task.dependencies : [];
}

function firstTouchOverlap(task, activeTasks) {
  const candidate = enrichTask(task);
  if (candidate.hints.touches.length === 0) return null;
  for (const active of activeTasks ?? []) {
    const blocker = enrichTask(active);
    if (blocker.id === candidate.id || blocker.hints.touches.length === 0) continue;
    for (const cPath of candidate.hints.touches) {
      for (const bPath of blocker.hints.touches) {
        if (pathsOverlap(cPath, bPath)) {
          return { taskId: blocker.id, path: cPath };
        }
      }
    }
  }
  return null;
}

/**
 * Classify one task against dependency readiness (backlog sequence), running
 * worktrees, active task touches, and capacity.
 *
 * @param {{ task: object, readyTaskIds?: Set<string>, runningWorktrees?: Map<string,string>|Set<string>|Record<string,string>, activeTasks?: object[], activeSlots?: number, max?: number }} p
 */
export function classifyTask({
  task,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  activeTasks = [],
  activeSlots = 0,
  max = Number.POSITIVE_INFINITY,
}) {
  const enriched = enrichTask(task);
  const worktree = runningWorktreeFor(runningWorktrees, enriched.id);
  if (worktree) {
    return { status: SKIP_RUNNING, task: enriched, worktree };
  }

  const unresolved = unresolvedDependencies(enriched, readyTaskIds);
  if (unresolved.length > 0) {
    return { status: WAIT_DEP, task: enriched, unresolved };
  }

  const overlap = firstTouchOverlap(enriched, activeTasks);
  if (overlap) {
    return { status: DEFER_TOUCHES, task: enriched, overlaps: overlap.taskId, path: overlap.path };
  }

  if (activeSlots >= max) {
    return { status: DEFER_CAPACITY, task: enriched, max };
  }

  return { status: READY_NOW, task: enriched };
}

/**
 * Build deterministic dry-run decisions. Tasks are processed in ascending
 * task id order, so lower-ordinal ready tasks reserve capacity/touches first.
 *
 * @param {{ tasks: object[], readyTaskIds?: Set<string>, runningWorktrees?: Map<string,string>|Set<string>|Record<string,string>, max?: number }} p
 */
export function planDryRun({
  tasks,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  max = 2,
}) {
  const enrichedTasks = [...tasks].map(enrichTask).sort((a, b) => a.id.localeCompare(b.id));
  const runningTasks = enrichedTasks.filter((task) => runningWorktreeFor(runningWorktrees, task.id));
  const selected = [];
  const decisions = [];

  for (const task of enrichedTasks) {
    const activeTasks = [...runningTasks, ...selected];
    const decision = classifyTask({
      task,
      readyTaskIds,
      runningWorktrees,
      activeTasks,
      activeSlots: activeTasks.length,
      max,
    });
    decisions.push(decision);
    if (decision.status === READY_NOW) selected.push(task);
  }

  return decisions;
}

/**
 * Run the live queue with injected side effects. `spawnTask` must return a
 * promise resolving to { status }. Touch conflicts against queue-launched
 * active tasks are re-evaluated after each completion.
 *
 * @param {{ tasks: object[], readyTaskIds?: Set<string>, runningWorktrees?: Map<string,string>|Set<string>|Record<string,string>, max?: number, maxFailures?: number, spawnTask: (task: object) => Promise<{status:number|null}>, log?: (line:string)=>void }} p
 */
export async function runQueue({
  tasks,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  max = 2,
  maxFailures = 3,
  spawnTask,
  log = () => {},
}) {
  const pending = [...tasks].map(enrichTask).sort((a, b) => a.id.localeCompare(b.id));
  const allTasks = pending;
  const runningTasks = allTasks.filter((task) => runningWorktreeFor(runningWorktrees, task.id));
  /** @type {Array<{ task: object, promise: Promise<{status:number|null}> }>} */
  const active = [];
  const launched = [];
  const skipped = [];
  let failed = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;

  function removePending(taskId) {
    const index = pending.findIndex((task) => task.id === taskId);
    if (index >= 0) pending.splice(index, 1);
  }

  function hasFailureBudgetForDispatch() {
    return maxFailures === 0 || consecutiveFailures + active.length < maxFailures;
  }

  for (const task of [...pending]) {
    const decision = classifyTask({
      task,
      readyTaskIds,
      runningWorktrees,
      activeTasks: runningTasks,
      activeSlots: runningTasks.length,
      max,
    });
    if (decision.status === SKIP_RUNNING || decision.status === WAIT_DEP) {
      log(formatDecision(decision));
      skipped.push(decision);
      removePending(task.id);
    }
  }

  while ((pending.length > 0 && !circuitOpen) || active.length > 0) {
    let madeProgress = false;

    while (
      !circuitOpen &&
      pending.length > 0 &&
      runningTasks.length + active.length < max &&
      hasFailureBudgetForDispatch()
    ) {
      const activeTasks = [...runningTasks, ...active.map((entry) => entry.task)];
      const startIndex = pending.findIndex((task) => (
        classifyTask({
          task,
          readyTaskIds,
          runningWorktrees,
          activeTasks,
          activeSlots: runningTasks.length + active.length,
          max,
        }).status === READY_NOW
      ));

      if (startIndex < 0) break;

      const [task] = pending.splice(startIndex, 1);
      const decision = { status: READY_NOW, task };
      log(formatDecision(decision));
      launched.push(task.id);
      const promise = Promise.resolve()
        .then(() => spawnTask(task))
        .catch((error) => {
          return { status: 1, error };
        });
      active.push({ task, promise });
      madeProgress = true;
    }

    if (active.length > 0) {
      const settled = await Promise.race(
        active.map((entry, index) => entry.promise.then((result) => ({ index, result }))),
      );
      const [done] = active.splice(settled.index, 1);
      const status = settled.result?.status ?? 1;
      log(`DONE ${done.task.id} status=${status}`);
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
      for (const task of pending.splice(0)) {
        const decision = classifyTask({
          task,
          readyTaskIds,
          runningWorktrees,
          activeTasks: runningTasks,
          activeSlots: runningTasks.length,
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
  const id = decision.task.id;
  switch (decision.status) {
    case READY_NOW:
      return `${READY_NOW} ${id}`;
    case WAIT_DEP:
      return `${WAIT_DEP} ${id} unresolved=${decision.unresolved.join(',')}`;
    case DEFER_TOUCHES:
      return `${DEFER_TOUCHES} ${id} overlaps=${decision.overlaps} path=${decision.path}`;
    case SKIP_RUNNING:
      return `${SKIP_RUNNING} ${id} worktree=${decision.worktree}`;
    case DEFER_CAPACITY:
      return `${DEFER_CAPACITY} ${id} max=${decision.max}`;
    default:
      return `UNKNOWN ${id}`;
  }
}

/**
 * Parse `git worktree list --porcelain` output for inner-task-<slug>
 * worktrees (ADR 0025 §4 / TASK-1.2 worktree naming, TASK-1.3 running
 * detection). Returns Map<slug, worktreePath> — the slug is the
 * `worktreeNameFor` suffix (e.g. "1-2" for TASK-1.2), not the task id
 * itself, since the mapping from slug back to task id is not 1:1
 * invertible in general; callers match by re-deriving the same slug from
 * candidate task ids (see taskWorktreeSlug in detectRunningWorktrees).
 * @param {string} worktreeListOutput
 * @returns {Map<string,string>}
 */
export function parseInnerTaskWorktrees(worktreeListOutput) {
  const running = new Map();
  for (const line of String(worktreeListOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/);
    if (!match) continue;
    const worktreePath = match[1].trim();
    const slugMatch = basename(worktreePath).match(/^inner-task-(.+)$/);
    if (!slugMatch) continue;
    running.set(slugMatch[1], worktreePath);
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

function backlogPlain(args) {
  const result = spawnSync(BACKLOG_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`backlog ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Parse `backlog task list --status "To Do" --plain` output into task ids +
 * titles (grouped-by-status plain text: "To Do:\n  TASK-1 - title\n...").
 * @param {string} text
 * @returns {Array<{ id: string, title: string }>}
 */
export function parseTaskListPlain(text) {
  const tasks = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\[[A-Z]+\]\s*)?(TASK-[^\s]+)\s*-\s*(.+)$/);
    if (match) tasks.push({ id: match[1], title: match[2].trim() });
  }
  return tasks;
}

/**
 * Parse `backlog sequence list --plain` output into Sequence-1 membership —
 * the set of task ids with no unresolved (not-yet-Done) dependency (ADR 0025
 * §4 / TASK-1.3: backlog computes the DAG, the queue only reads Sequence 1).
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseSequenceListPlain(text) {
  const ready = new Set();
  let inSequenceOne = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const headingMatch = line.match(/^Sequence\s+(\d+):\s*$/);
    if (headingMatch) {
      inSequenceOne = headingMatch[1] === '1';
      continue;
    }
    if (!inSequenceOne) continue;
    const taskMatch = line.match(/^\s*(TASK-[^\s]+)\s*-/);
    if (taskMatch) ready.add(taskMatch[1]);
  }
  return ready;
}

function fetchQueueTasks() {
  const listed = parseTaskListPlain(backlogPlain(['task', 'list', '--status', 'To Do', '--plain']));
  return listed.map(({ id, title }) => {
    const viewed = parseTaskViewPlain(backlogPlain(['task', 'view', id, '--plain']));
    return {
      id,
      title: viewed.title ?? title,
      body: viewed.body ?? '',
      dependencies: viewed.dependencies ?? [],
    };
  });
}

function fetchReadyTaskIds() {
  return parseSequenceListPlain(backlogPlain(['sequence', 'list', '--plain']));
}

function fetchTaskState(taskId) {
  return parseTaskViewPlain(backlogPlain(['task', 'view', taskId, '--plain'])).status;
}

// Derive the `inner-task-<slug>` worktree dirname suffix for a task id, the
// same way worktreeNameFor (inner-loop.mjs) does: taskUnitToSlug yields the
// run_key slug ("task-1-2") with its "task-" prefix stripped ("1-2").
function taskWorktreeSlug(taskId) {
  return taskUnitToSlug(taskId).replace(/^task-/, '');
}

function detectRunningWorktrees(tasks) {
  const running = new Map();
  const bySlug = new Map(tasks.map((task) => [taskWorktreeSlug(task.id), task.id]));

  const listResult = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (listResult.status === 0) {
    for (const [slug, worktreePath] of parseInnerTaskWorktrees(listResult.stdout)) {
      const taskId = bySlug.get(slug);
      if (taskId) running.set(taskId, worktreePath);
    }
  }

  for (const task of tasks) {
    const p = join(REPO_ROOT, '.claude', 'worktrees', `inner-task-${taskWorktreeSlug(task.id)}`);
    if (existsSync(p)) running.set(task.id, p);
  }
  return running;
}

export function buildInnerLoopSpawnSpec(task, logFd) {
  return {
    command: process.execPath,
    args: ['scripts/inner-loop.mjs', '--task', task.id],
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
  checkState = fetchTaskState,
  spawnChild = spawn,
  log = (line) => process.stdout.write(`${line}\n`),
  logRoot = join(REPO_ROOT, '.lathe', 'runs'),
  now = () => new Date(),
} = {}) {
  const logPath = join(logRoot, `task-${taskWorktreeSlug(task.id)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  let state;
  try {
    state = String(await checkState(task.id) ?? 'UNKNOWN');
  } catch (error) {
    appendQueueLog(logPath, `[inner-queue] state check error before task ${task.id}: ${error.message}`);
    return { status: 1 };
  }

  if (state !== 'To Do') {
    const line = `SKIP_NOT_TODO ${task.id} (status=${state} at dispatch)`;
    log(line);
    appendQueueLog(logPath, `[inner-queue] ${line}`);
    return { status: 0 };
  }

  return new Promise((resolve) => {
    appendQueueLog(logPath, `[inner-queue] start task ${task.id} at ${now().toISOString()}`);

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
      appendQueueLog(logPath, `\n[inner-queue] done task ${task.id} status=${code ?? 'null'} signal=${signal ?? 'null'} at ${now().toISOString()}`);
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
  try {
    tasks = fetchQueueTasks();
    readyTaskIds = fetchReadyTaskIds();
  } catch (e) {
    die(e.message);
  }
  const runningWorktrees = detectRunningWorktrees(tasks);

  if (parsed.dryRun) {
    const decisions = planDryRun({
      tasks,
      readyTaskIds,
      runningWorktrees,
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
    max: parsed.max,
    maxFailures: parsed.maxFailures,
    spawnTask: spawnInnerLoop,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  process.exit(result.failed === 0 ? 0 : 1);
}
