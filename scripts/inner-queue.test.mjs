// Tests for the gh-wired inner queue (#116, ADR 0031): open task-request
// issues as tasks, blocked-by readiness, In Progress derivation from open
// PRs, escalation-label skip, touches overlap, and dispatch mechanics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEEDS_REVIEW_LABEL } from './inner-loop-core.mjs';
import {
  buildInnerLoopSpawnSpec,
  DEFER_CAPACITY,
  DEFER_TOUCHES,
  READY_NOW,
  SKIP_RUNNING,
  SKIP_IN_PROGRESS,
  SKIP_ESCALATION,
  WAIT_APPROVAL,
  WAIT_DEP,
  classifyTask,
  formatDecision,
  parseTaskRunHints,
  parseInnerIssueWorktrees,
  deriveReadyTaskIds,
  deriveInProgressIssueNumbers,
  pathsOverlap,
  planDryRun,
  runQueue,
  spawnInnerLoop,
} from './inner-queue.mjs';

// --- parseTaskRunHints ---

test('parseTaskRunHints: Touches lines are parsed case-insensitively and de-duped', () => {
  const hints = parseTaskRunHints([
    'Intro mentions should not count.',
    'Touches: scripts/inner-loop.mjs, apps/web/lib/, scripts/inner-loop.mjs',
    'touches: packages/shared/src',
  ].join('\n'));
  assert.deepEqual(hints.touches, ['scripts/inner-loop.mjs', 'apps/web/lib/', 'packages/shared/src']);
});

test('parseTaskRunHints: non-heading mentions are ignored', () => {
  assert.deepEqual(parseTaskRunHints('Body text\n- Touches: scripts/x.mjs'), { touches: [] });
});

// --- pathsOverlap ---

test('pathsOverlap: exact and parent-child matches overlap only at segment boundaries', () => {
  assert.equal(pathsOverlap('apps/web/lib', './apps/web/lib/'), true);
  assert.equal(pathsOverlap('apps/web/lib', 'apps/web/lib/db.ts'), true);
  assert.equal(pathsOverlap('apps/web/liberation', 'apps/web/lib'), false);
  assert.equal(pathsOverlap('scripts/inner-loop.mjs', 'scripts/inner-queue.mjs'), false);
  assert.equal(pathsOverlap('.', 'anything'), true);
});

// --- parseInnerIssueWorktrees ---

test('parseInnerIssueWorktrees: extracts inner-issue worktrees from git porcelain output', () => {
  const output = [
    'worktree /repo',
    'HEAD abc',
    '',
    'worktree /repo/.claude/worktrees/inner-issue-42',
    'HEAD def',
    '',
    'worktree /repo/.claude/worktrees/agent-xyz',
    'HEAD ghi',
  ].join('\n');
  const running = parseInnerIssueWorktrees(output);
  assert.deepEqual([...running.entries()], [[42, '/repo/.claude/worktrees/inner-issue-42']]);
});

// --- deriveReadyTaskIds / deriveInProgressIssueNumbers ---

test('deriveReadyTaskIds: ready when every blocked-by ref is not open', () => {
  const tasks = [
    { id: 10, body: 'no deps' },
    { id: 11, body: 'blocked-by #10' },
    { id: 12, body: 'blocked-by #99' },
  ];
  const ready = deriveReadyTaskIds(tasks, new Set([10]));
  assert.equal(ready.has(10), true);
  assert.equal(ready.has(11), false, 'ref #10 is open -> not ready');
  assert.equal(ready.has(12), true, 'ref #99 is not open -> ready');
});

test('deriveInProgressIssueNumbers: Closes body refs and inner/issue-<n> branches', () => {
  const prs = [
    { body: 'stuff\n\nCloses #42', headRefName: 'feature/x' },
    { body: '', headRefName: 'inner/issue-7' },
    { body: 'Fixes #9 and resolves #10', headRefName: 'z' },
    { body: 'relates to #99', headRefName: 'y' },
  ];
  const inProgress = deriveInProgressIssueNumbers(prs);
  assert.deepEqual([...inProgress].sort((a, b) => a - b), [7, 9, 10, 42]);
});

// --- classifyTask ---

test('classifyTask: escalation label is skipped (裁定 loop material, ADR 0030 追記 E)', () => {
  const decision = classifyTask({ task: { id: 5, body: '', labels: ['task-request', 'escalation'] } });
  assert.equal(decision.status, SKIP_ESCALATION);
});

test('classifyTask: open PR referencing the issue means In Progress', () => {
  const decision = classifyTask({
    task: { id: 5, body: '', labels: [] },
    inProgressIssueNumbers: new Set([5]),
  });
  assert.equal(decision.status, SKIP_IN_PROGRESS);
});

test('classifyTask: needs-review gate uses the single-sourced core label constant (#192 Minor#3)', () => {
  // The label the driver/core write and the label the queue gates on must be
  // the same constant — a task labelled with inner-loop-core's
  // NEEDS_REVIEW_LABEL waits for Projects Ready approval.
  const task = { id: 5, body: '', labels: ['task-request', NEEDS_REVIEW_LABEL] };
  const waiting = classifyTask({ task, readyTaskIds: new Set([5]) });
  assert.equal(waiting.status, WAIT_APPROVAL);
  const approved = classifyTask({ task, readyTaskIds: new Set([5]), approvedIssueNumbers: new Set([5]) });
  assert.equal(approved.status, READY_NOW);
});

test('classifyTask: running worktree wins over dependency wait', () => {
  const decision = classifyTask({
    task: { id: 5, body: 'blocked-by #4', labels: [] },
    runningWorktrees: new Map([[5, '/wt/inner-issue-5']]),
  });
  assert.equal(decision.status, SKIP_RUNNING);
});

// --- planDryRun ---

test('planDryRun: reports ready, dep wait, touch conflict, running, in-progress, escalation, and capacity', () => {
  const tasks = [
    { id: 1, body: 'Touches: scripts/', labels: [] },
    { id: 2, body: 'blocked-by #1', labels: [] },
    { id: 3, body: 'Touches: scripts/inner-loop.mjs', labels: [] },
    { id: 4, body: '', labels: [] },
    { id: 5, body: '', labels: [] },
    { id: 6, body: '', labels: ['escalation'] },
    { id: 7, body: '', labels: [] },
  ];
  const decisions = planDryRun({
    tasks,
    readyTaskIds: new Set([1, 3, 4, 5, 7]),
    runningWorktrees: new Map([[4, '/wt/inner-issue-4']]),
    inProgressIssueNumbers: new Set([5]),
    max: 2,
  });
  const byId = new Map(decisions.map((d) => [d.task.id, d]));
  assert.equal(byId.get(1).status, READY_NOW);
  assert.equal(byId.get(2).status, WAIT_DEP);
  assert.deepEqual(byId.get(2).unresolved, [1]);
  assert.equal(byId.get(3).status, DEFER_TOUCHES, 'scripts/inner-loop.mjs overlaps scripts/');
  assert.equal(byId.get(4).status, SKIP_RUNNING);
  assert.equal(byId.get(5).status, SKIP_IN_PROGRESS);
  assert.equal(byId.get(6).status, SKIP_ESCALATION);
  assert.equal(byId.get(7).status, DEFER_CAPACITY, 'running #4 + ready #1 fill max=2');
});

test('formatDecision: renders issue-numbered decisions', () => {
  assert.equal(formatDecision({ status: READY_NOW, task: { id: 9 } }), 'READY_NOW #9');
  assert.equal(formatDecision({ status: WAIT_DEP, task: { id: 9 }, unresolved: [1, 2] }), 'WAIT_DEP #9 unresolved=#1,#2');
  assert.match(formatDecision({ status: SKIP_ESCALATION, task: { id: 9 } }), /escalation label/);
});

// --- buildInnerLoopSpawnSpec ---

test('buildInnerLoopSpawnSpec: spawns the driver with the bare issue number and log fd stdio', () => {
  const spec = buildInnerLoopSpawnSpec({ id: 42 }, 7);
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, ['scripts/inner-loop.mjs', '42']);
  assert.deepEqual(spec.options.stdio, ['ignore', 7, 7]);
});

// --- spawnInnerLoop ---

test('spawnInnerLoop: skips an issue that is no longer open at dispatch without spawning', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'lathe-queue-test-'));
  const lines = [];
  let spawned = 0;
  try {
    const result = await spawnInnerLoop({ id: 42 }, {
      checkState: () => 'CLOSED',
      spawnChild: () => { spawned += 1; return new EventEmitter(); },
      log: (line) => lines.push(line),
      logRoot,
    });
    assert.deepEqual(result, { status: 0 });
    assert.equal(spawned, 0);
    assert.ok(lines.some((line) => line.includes('SKIP_NOT_OPEN #42')));
    assert.ok(readFileSync(join(logRoot, 'issue-42.log'), 'utf8').includes('SKIP_NOT_OPEN #42'));
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('spawnInnerLoop: spawns an OPEN issue after the dispatch state check', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'lathe-queue-test-'));
  let spec = null;
  try {
    const child = new EventEmitter();
    const resultPromise = spawnInnerLoop({ id: 42 }, {
      checkState: () => 'OPEN',
      spawnChild: (command, args, options) => { spec = { command, args, options }; return child; },
      log: () => {},
      logRoot,
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    const result = await resultPromise;
    assert.deepEqual(result, { status: 0 });
    assert.deepEqual(spec.args, ['scripts/inner-loop.mjs', '42']);
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

// --- runQueue ---

test('runQueue: unresolved dependency is not spawned in live mode', async () => {
  const launched = [];
  const result = await runQueue({
    tasks: [
      { id: 1, body: '', labels: [] },
      { id: 2, body: 'blocked-by #1', labels: [] },
    ],
    readyTaskIds: new Set([1]),
    spawnTask: (task) => { launched.push(task.id); return Promise.resolve({ status: 0 }); },
  });
  assert.deepEqual(launched, [1]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].status, WAIT_DEP);
});

test('runQueue: escalation and in-progress tasks are pre-skipped', async () => {
  const launched = [];
  const result = await runQueue({
    tasks: [
      { id: 1, body: '', labels: ['escalation'] },
      { id: 2, body: '', labels: [] },
      { id: 3, body: '', labels: [] },
    ],
    readyTaskIds: new Set([1, 2, 3]),
    inProgressIssueNumbers: new Set([2]),
    spawnTask: (task) => { launched.push(task.id); return Promise.resolve({ status: 0 }); },
  });
  assert.deepEqual(launched, [3]);
  const statuses = result.skipped.map((d) => d.status).sort();
  assert.deepEqual(statuses, [SKIP_ESCALATION, SKIP_IN_PROGRESS]);
});

test('runQueue: circuit breaker stops dispatch after three consecutive failures', async () => {
  const launched = [];
  const tasks = [1, 2, 3, 4, 5].map((n) => ({ id: n, body: '', labels: [] }));
  const result = await runQueue({
    tasks,
    readyTaskIds: new Set([1, 2, 3, 4, 5]),
    max: 1,
    maxFailures: 3,
    spawnTask: (task) => { launched.push(task.id); return Promise.resolve({ status: 1 }); },
  });
  assert.deepEqual(launched, [1, 2, 3]);
  assert.equal(result.failed, 3);
});

test('runQueue: successful completion resets the consecutive failure count', async () => {
  const launched = [];
  const tasks = [1, 2, 3, 4, 5].map((n) => ({ id: n, body: '', labels: [] }));
  const statusById = { 1: 1, 2: 1, 3: 0, 4: 1, 5: 1 };
  const result = await runQueue({
    tasks,
    readyTaskIds: new Set([1, 2, 3, 4, 5]),
    max: 1,
    maxFailures: 3,
    spawnTask: (task) => { launched.push(task.id); return Promise.resolve({ status: statusById[task.id] }); },
  });
  assert.deepEqual(launched, [1, 2, 3, 4, 5]);
  assert.equal(result.failed, 4);
});

test('runQueue: maxFailures 0 disables the circuit breaker', async () => {
  const launched = [];
  const tasks = [1, 2, 3, 4].map((n) => ({ id: n, body: '', labels: [] }));
  await runQueue({
    tasks,
    readyTaskIds: new Set([1, 2, 3, 4]),
    max: 1,
    maxFailures: 0,
    spawnTask: (task) => { launched.push(task.id); return Promise.resolve({ status: 1 }); },
  });
  assert.deepEqual(launched, [1, 2, 3, 4]);
});

test('runQueue: overlapping Touches are serialized — the second starts after the blocker exits', async () => {
  const events = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  const tasks = [
    { id: 1, body: 'Touches: scripts/', labels: [] },
    { id: 2, body: 'Touches: scripts/inner-loop.mjs', labels: [] },
  ];
  const queue = runQueue({
    tasks,
    readyTaskIds: new Set([1, 2]),
    max: 2,
    spawnTask: (task) => {
      events.push(`start-${task.id}`);
      if (task.id === 1) return firstDone.then(() => ({ status: 0 }));
      return Promise.resolve({ status: 0 });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start-1'], 'task 2 must not start while task 1 holds scripts/');
  releaseFirst();
  const result = await queue;
  assert.deepEqual(result.launched, [1, 2]);
  assert.deepEqual(events, ['start-1', 'start-2']);
});
