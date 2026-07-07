import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInnerLoopSpawnSpec,
  DEFER_CAPACITY,
  DEFER_TOUCHES,
  READY_NOW,
  SKIP_RUNNING,
  WAIT_DEP,
  formatDecision,
  parseTaskRunHints,
  parseInnerTaskWorktrees,
  parseTaskListPlain,
  parseSequenceListPlain,
  pathsOverlap,
  planDryRun,
  runQueue,
  spawnInnerLoop,
} from './inner-queue.mjs';

function task(id, body = '', dependencies = []) {
  return { id, title: `task ${id}`, body, dependencies };
}

test('parseTaskRunHints: Touches lines are parsed case-insensitively and de-duped', () => {
  const hints = parseTaskRunHints([
    'Intro mentions should not count.',
    'Touches: scripts/inner-loop.mjs, apps/web/lib/, scripts/inner-loop.mjs',
    'touches: packages/shared/src',
  ].join('\n'));

  assert.deepEqual(hints.touches, ['scripts/inner-loop.mjs', 'apps/web/lib/', 'packages/shared/src']);
});

test('parseTaskRunHints: non-heading mentions are ignored', () => {
  const hints = parseTaskRunHints('Body text\n- Touches: scripts/x.mjs');
  assert.deepEqual(hints, { touches: [] });
});

test('pathsOverlap: exact and parent-child matches overlap only at segment boundaries', () => {
  assert.equal(pathsOverlap('apps/web/lib', './apps/web/lib/'), true);
  assert.equal(pathsOverlap('apps/web/lib', 'apps/web/lib/db.ts'), true);
  assert.equal(pathsOverlap('apps/web/liberation', 'apps/web/lib'), false);
  assert.equal(pathsOverlap('scripts/inner-loop.mjs', 'scripts/inner-queue.mjs'), false);
});

test('parseInnerTaskWorktrees: extracts inner task worktrees from git porcelain output', () => {
  const running = parseInnerTaskWorktrees([
    'worktree /repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/inner-task-1-2',
    'HEAD def',
    'branch refs/heads/inner/task-1-2',
    '',
    'worktree /tmp/other-worktree',
  ].join('\n'));

  assert.deepEqual([...running.entries()], [['1-2', '/repo/.claude/worktrees/inner-task-1-2']]);
});

test('parseTaskListPlain: extracts task ids and titles from grouped-by-status plain output', () => {
  const tasks = parseTaskListPlain([
    'To Do:',
    '  [HIGH] TASK-1 - Phase 2 rewire',
    '  TASK-2 - feat(meta): meta-loop driver',
  ].join('\n'));

  assert.deepEqual(tasks, [
    { id: 'TASK-1', title: 'Phase 2 rewire' },
    { id: 'TASK-2', title: 'feat(meta): meta-loop driver' },
  ]);
});

test('parseSequenceListPlain: returns only Sequence 1 task ids as dependency-ready', () => {
  const ready = parseSequenceListPlain([
    'Sequence 1:',
    '  TASK-1 - first',
    '  TASK-3 - third',
    '',
    'Sequence 2:',
    '  TASK-2 - second',
  ].join('\n'));

  assert.deepEqual([...ready], ['TASK-1', 'TASK-3']);
});

test('planDryRun: reports ready, dependency wait, touch conflict, running, and capacity', () => {
  const tasks = [
    task('TASK-1', 'Touches: scripts/a.mjs'),
    task('TASK-2', 'Touches: scripts/b.mjs', ['TASK-99']),
    task('TASK-3', 'Touches: scripts/a.mjs'),
    task('TASK-4', 'Touches: scripts/c.mjs'),
    task('TASK-5', 'Touches: scripts/d.mjs'),
  ];
  const readyTaskIds = new Set(['TASK-1', 'TASK-3', 'TASK-4', 'TASK-5']);
  const running = new Map([['TASK-4', '/repo/.claude/worktrees/inner-task-4']]);

  const decisions = planDryRun({ tasks, readyTaskIds, runningWorktrees: running, max: 2 });

  assert.deepEqual(decisions.map((d) => d.status), [
    READY_NOW,
    WAIT_DEP,
    DEFER_TOUCHES,
    SKIP_RUNNING,
    DEFER_CAPACITY,
  ]);
  assert.equal(formatDecision(decisions[0]), 'READY_NOW TASK-1');
  assert.equal(formatDecision(decisions[1]), 'WAIT_DEP TASK-2 unresolved=TASK-99');
  assert.equal(formatDecision(decisions[2]), 'DEFER_TOUCHES TASK-3 overlaps=TASK-1 path=scripts/a.mjs');
  assert.equal(formatDecision(decisions[3]), 'SKIP_RUNNING TASK-4 worktree=/repo/.claude/worktrees/inner-task-4');
  assert.equal(formatDecision(decisions[4]), 'DEFER_CAPACITY TASK-5 max=2');
});

test('buildInnerLoopSpawnSpec: routes child stdout and stderr directly to the log fd', () => {
  const spec = buildInnerLoopSpawnSpec(task('TASK-54'), 123);

  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, ['scripts/inner-loop.mjs', '--task', 'TASK-54']);
  assert.deepEqual(spec.options.stdio, ['ignore', 123, 123]);
  assert.equal(spec.options.env, process.env);
});

test('spawnInnerLoop: skips task no longer To Do at dispatch without spawning driver', async (t) => {
  const logRoot = mkdtempSync(join(tmpdir(), 'inner-queue-test-'));
  t.after(() => rmSync(logRoot, { recursive: true, force: true }));

  let spawned = false;
  const logs = [];
  const result = await spawnInnerLoop(task('TASK-60'), {
    logRoot,
    checkState: async (taskId) => {
      assert.equal(taskId, 'TASK-60');
      return 'Done';
    },
    spawnChild: () => {
      spawned = true;
      throw new Error('driver should not spawn');
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.status, 0);
  assert.equal(spawned, false);
  assert.deepEqual(logs, ['SKIP_NOT_TODO TASK-60 (status=Done at dispatch)']);
});

test('spawnInnerLoop: spawns To Do task after dispatch state check', async (t) => {
  const logRoot = mkdtempSync(join(tmpdir(), 'inner-queue-test-'));
  t.after(() => rmSync(logRoot, { recursive: true, force: true }));

  let spawnedSpec = null;
  const result = await spawnInnerLoop(task('TASK-61'), {
    logRoot,
    checkState: async (taskId) => {
      assert.equal(taskId, 'TASK-61');
      return 'To Do';
    },
    spawnChild: (command, args, options) => {
      spawnedSpec = { command, args, options };
      const child = new EventEmitter();
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    },
    log: () => {
      throw new Error('To Do task should not log SKIP_NOT_TODO');
    },
  });

  assert.equal(result.status, 0);
  assert.equal(spawnedSpec.command, process.execPath);
  assert.deepEqual(spawnedSpec.args, ['scripts/inner-loop.mjs', '--task', 'TASK-61']);
  assert.deepEqual(spawnedSpec.options.stdio.slice(0, 1), ['ignore']);
  assert.equal(typeof spawnedSpec.options.stdio[1], 'number');
  assert.equal(spawnedSpec.options.stdio[2], spawnedSpec.options.stdio[1]);
});

test('runQueue: unresolved dependency is not spawned in live mode', async () => {
  const spawned = [];
  const logs = [];
  const result = await runQueue({
    tasks: [task('TASK-10', 'Touches: scripts/x.mjs', ['TASK-37'])],
    readyTaskIds: new Set(),
    runningWorktrees: new Map(),
    max: 2,
    spawnTask: async (candidate) => {
      spawned.push(candidate.id);
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launched, []);
  assert.equal(result.failed, 0);
  assert.ok(logs.includes('WAIT_DEP TASK-10 unresolved=TASK-37'));
});

test('runQueue: circuit breaker stops dispatch after three consecutive failures', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    tasks: [task('TASK-1'), task('TASK-2'), task('TASK-3'), task('TASK-4'), task('TASK-5')],
    readyTaskIds: new Set(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']),
    runningWorktrees: new Map(),
    max: 1,
    spawnTask: async (candidate) => {
      spawned.push(candidate.id);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.deepEqual(result.launched, ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.equal(result.failed, 3);
  assert.ok(logs.includes('CIRCUIT_OPEN after 3 consecutive failures — dispatch halted'));
});

test('runQueue: circuit breaker stops dispatch before replenishing default parallelism', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    tasks: [task('TASK-1'), task('TASK-2'), task('TASK-3'), task('TASK-4'), task('TASK-5')],
    readyTaskIds: new Set(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']),
    runningWorktrees: new Map(),
    spawnTask: async (candidate) => {
      spawned.push(candidate.id);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.deepEqual(result.launched, ['TASK-1', 'TASK-2', 'TASK-3']);
  assert.equal(result.failed, 3);
  assert.ok(logs.includes('CIRCUIT_OPEN after 3 consecutive failures — dispatch halted'));
});

test('runQueue: successful completion resets consecutive failure count', async () => {
  const statuses = new Map([
    ['TASK-1', 1],
    ['TASK-2', 0],
    ['TASK-3', 1],
    ['TASK-4', 1],
  ]);
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    tasks: [task('TASK-1'), task('TASK-2'), task('TASK-3'), task('TASK-4')],
    readyTaskIds: new Set(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']),
    runningWorktrees: new Map(),
    max: 1,
    spawnTask: async (candidate) => {
      spawned.push(candidate.id);
      return { status: statuses.get(candidate.id) };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
  assert.deepEqual(result.launched, ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
  assert.equal(result.failed, 3);
  assert.ok(!logs.some((line) => line.startsWith('CIRCUIT_OPEN ')));
});

test('runQueue: maxFailures 0 disables the circuit breaker', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    tasks: [task('TASK-1'), task('TASK-2'), task('TASK-3'), task('TASK-4'), task('TASK-5')],
    readyTaskIds: new Set(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']),
    runningWorktrees: new Map(),
    max: 1,
    maxFailures: 0,
    spawnTask: async (candidate) => {
      spawned.push(candidate.id);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']);
  assert.deepEqual(result.launched, ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']);
  assert.equal(result.failed, 5);
  assert.ok(!logs.some((line) => line.startsWith('CIRCUIT_OPEN ')));
});

test('runQueue: overlapping Touches are not active at the same time and start after the blocker exits', async () => {
  const started = [];
  const resolvers = new Map();
  const active = new Set();
  const concurrentSnapshots = [];

  const queuePromise = runQueue({
    tasks: [
      task('TASK-1', 'Touches: scripts/a.mjs'),
      task('TASK-2', 'Touches: scripts/a.mjs'),
      task('TASK-3', 'Touches: scripts/b.mjs'),
    ],
    readyTaskIds: new Set(['TASK-1', 'TASK-2', 'TASK-3']),
    runningWorktrees: new Map(),
    max: 2,
    spawnTask: (candidate) => {
      started.push(candidate.id);
      active.add(candidate.id);
      concurrentSnapshots.push([...active].sort());
      return new Promise((resolve) => {
        resolvers.set(candidate.id, () => {
          active.delete(candidate.id);
          resolve({ status: 0 });
        });
      });
    },
  });

  await waitUntil(() => started.includes('TASK-1') && started.includes('TASK-3'));
  assert.deepEqual(started, ['TASK-1', 'TASK-3']);
  assert.ok(!started.includes('TASK-2'), 'TASK-2 must wait while TASK-1 with overlapping Touches is active');

  resolvers.get('TASK-1')();
  await waitUntil(() => started.includes('TASK-2'));
  assert.deepEqual(started, ['TASK-1', 'TASK-3', 'TASK-2']);
  assert.ok(
    concurrentSnapshots.every((snapshot) => !(snapshot.includes('TASK-1') && snapshot.includes('TASK-2'))),
    'tasks with overlapping Touches must not be active together',
  );

  resolvers.get('TASK-2')();
  resolvers.get('TASK-3')();
  const result = await queuePromise;
  assert.deepEqual(result.launched, ['TASK-1', 'TASK-3', 'TASK-2']);
  assert.equal(result.failed, 0);
});

async function waitUntil(predicate) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('timed out waiting for queue state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
