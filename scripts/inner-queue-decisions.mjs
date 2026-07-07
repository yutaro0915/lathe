// inner-queue-decisions.mjs — pure decision logic for the inner-queue
// dispatcher (scripts/inner-queue.mjs). Split at the #116 task-loop shrink to
// keep every module under the 500-line file-size guard.
//
// After ADR 0031 the queue's unit is a GitHub issue (issue = task): readiness
// comes from `blocked-by #N` body refs, "In Progress" is derived from open
// PRs, and `escalation`-labelled issues are 裁定 loop material, not driver
// work (ADR 0030 追記 E). No side effects here.

import { basename, posix } from 'node:path';
import { parseBlockedBy } from './inner-loop-core.mjs';

export const READY_NOW = 'READY_NOW';
export const WAIT_DEP = 'WAIT_DEP';
export const SKIP_RUNNING = 'SKIP_RUNNING';
export const SKIP_IN_PROGRESS = 'SKIP_IN_PROGRESS';
export const SKIP_ESCALATION = 'SKIP_ESCALATION';
export const DEFER_TOUCHES = 'DEFER_TOUCHES';
export const DEFER_CAPACITY = 'DEFER_CAPACITY';

export const ESCALATION_LABEL = 'escalation';

/**
 * Parse machine-readable inner-loop hints from an issue body. Only Touches
 * survives here (dependency ordering comes from blocked-by refs).
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
    dependencies: task.dependencies ?? parseBlockedBy(task.body ?? ''),
  };
}

function runningWorktreeFor(runningWorktrees, taskId) {
  if (!runningWorktrees) return null;
  if (runningWorktrees instanceof Map) return runningWorktrees.get(taskId) ?? null;
  if (runningWorktrees instanceof Set) return runningWorktrees.has(taskId) ? true : null;
  return runningWorktrees[taskId] ?? null;
}

/**
 * Derive the set of ready task ids: a task is dependency-ready when every
 * `blocked-by #N` ref points at a non-open issue (ADR 0031 §2).
 * @param {Array<{ id: number, dependencies?: number[], body?: string }>} tasks
 * @param {Set<number>} openIssueNumbers - issue numbers known to be open
 * @returns {Set<number>}
 */
export function deriveReadyTaskIds(tasks, openIssueNumbers) {
  const ready = new Set();
  for (const task of tasks ?? []) {
    const deps = Array.isArray(task.dependencies) ? task.dependencies : parseBlockedBy(task.body ?? '');
    if (deps.every((ref) => !openIssueNumbers.has(ref))) ready.add(task.id);
  }
  return ready;
}

/**
 * Derive "In Progress" issue numbers from open PRs (ADR 0031 §2: In Progress
 * = an open PR references the issue). A PR references an issue via a
 * closing keyword in its body (`Closes/Fixes/Resolves #N` — landBranch always
 * writes `Closes #N`, #116) or via the `inner/issue-<n>` head branch.
 * @param {Array<{ body?: string, headRefName?: string }>} prs
 * @returns {Set<number>}
 */
export function deriveInProgressIssueNumbers(prs) {
  const inProgress = new Set();
  for (const pr of prs ?? []) {
    for (const m of String(pr?.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
      inProgress.add(Number(m[1]));
    }
    const branchMatch = String(pr?.headRefName ?? '').match(/^inner\/issue-(\d+)$/);
    if (branchMatch) inProgress.add(Number(branchMatch[1]));
  }
  return inProgress;
}

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
 * Classify one task against the escalation label, in-progress PRs, running
 * worktrees, dependency readiness, active task touches, and capacity.
 *
 * @param {{ task: object, readyTaskIds?: Set<number>, runningWorktrees?: Map<number,string>|Set<number>|Record<number,string>, inProgressIssueNumbers?: Set<number>, activeTasks?: object[], activeSlots?: number, max?: number }} p
 */
export function classifyTask({
  task,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  inProgressIssueNumbers = new Set(),
  activeTasks = [],
  activeSlots = 0,
  max = Number.POSITIVE_INFINITY,
}) {
  const enriched = enrichTask(task);

  if ((enriched.labels ?? []).some((name) => String(name).toLowerCase() === ESCALATION_LABEL)) {
    return { status: SKIP_ESCALATION, task: enriched };
  }

  if (inProgressIssueNumbers.has(enriched.id)) {
    return { status: SKIP_IN_PROGRESS, task: enriched };
  }

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
 * issue-number order, so lower-numbered ready tasks reserve capacity/touches
 * first.
 *
 * @param {{ tasks: object[], readyTaskIds?: Set<number>, runningWorktrees?: Map<number,string>|Set<number>|Record<number,string>, inProgressIssueNumbers?: Set<number>, max?: number }} p
 */
export function planDryRun({
  tasks,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  inProgressIssueNumbers = new Set(),
  max = 2,
}) {
  const enrichedTasks = [...tasks].map(enrichTask).sort((a, b) => a.id - b.id);
  const runningTasks = enrichedTasks.filter((task) => runningWorktreeFor(runningWorktrees, task.id));
  const selected = [];
  const decisions = [];

  for (const task of enrichedTasks) {
    const activeTasks = [...runningTasks, ...selected];
    const decision = classifyTask({
      task,
      readyTaskIds,
      runningWorktrees,
      inProgressIssueNumbers,
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
 * @param {{ tasks: object[], readyTaskIds?: Set<number>, runningWorktrees?: Map<number,string>|Set<number>|Record<number,string>, inProgressIssueNumbers?: Set<number>, max?: number, maxFailures?: number, spawnTask: (task: object) => Promise<{status:number|null}>, log?: (line:string)=>void }} p
 */
export async function runQueue({
  tasks,
  readyTaskIds = new Set(),
  runningWorktrees = new Map(),
  inProgressIssueNumbers = new Set(),
  max = 2,
  maxFailures = 3,
  spawnTask,
  log = () => {},
}) {
  const pending = [...tasks].map(enrichTask).sort((a, b) => a.id - b.id);
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
      inProgressIssueNumbers,
      activeTasks: runningTasks,
      activeSlots: runningTasks.length,
      max,
    });
    if ([SKIP_RUNNING, SKIP_IN_PROGRESS, SKIP_ESCALATION, WAIT_DEP].includes(decision.status)) {
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
          inProgressIssueNumbers,
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
      log(`DONE #${done.task.id} status=${status}`);
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
          inProgressIssueNumbers,
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
  const id = `#${decision.task.id}`;
  switch (decision.status) {
    case READY_NOW:
      return `${READY_NOW} ${id}`;
    case WAIT_DEP:
      return `${WAIT_DEP} ${id} unresolved=${decision.unresolved.map((n) => `#${n}`).join(',')}`;
    case DEFER_TOUCHES:
      return `${DEFER_TOUCHES} ${id} overlaps=#${decision.overlaps} path=${decision.path}`;
    case SKIP_RUNNING:
      return `${SKIP_RUNNING} ${id} worktree=${decision.worktree}`;
    case SKIP_IN_PROGRESS:
      return `${SKIP_IN_PROGRESS} ${id} (open PR references the issue)`;
    case SKIP_ESCALATION:
      return `${SKIP_ESCALATION} ${id} (escalation label — 裁定 loop material, not driver work)`;
    case DEFER_CAPACITY:
      return `${DEFER_CAPACITY} ${id} max=${decision.max}`;
    default:
      return `UNKNOWN ${id}`;
  }
}

/**
 * Parse `git worktree list --porcelain` output for inner-issue-<n> worktrees
 * (worktreeNameFor naming). Returns Map<issueNumber, worktreePath>.
 * @param {string} worktreeListOutput
 * @returns {Map<number,string>}
 */
export function parseInnerIssueWorktrees(worktreeListOutput) {
  const running = new Map();
  for (const line of String(worktreeListOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/);
    if (!match) continue;
    const worktreePath = match[1].trim();
    const issueMatch = basename(worktreePath).match(/^inner-issue-(\d+)$/);
    if (!issueMatch) continue;
    running.set(Number(issueMatch[1]), worktreePath);
  }
  return running;
}
