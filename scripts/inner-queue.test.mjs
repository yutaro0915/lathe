import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInnerLoopSpawnSpec,
  DEFER_CAPACITY,
  DEFER_TOUCHES,
  READY_NOW,
  SKIP_RUNNING,
  WAIT_DEP,
  formatDecision,
  parseIssueRunHints,
  parseInnerIssueWorktrees,
  pathsOverlap,
  planDryRun,
  runQueue,
} from './inner-queue.mjs';

function issue(number, body = '') {
  return { number, title: `issue ${number}`, body };
}

test('parseIssueRunHints: Depends-on and Touches lines are parsed case-insensitively and de-duped', () => {
  const hints = parseIssueRunHints([
    'Intro #999 should not count.',
    'Depends-on: #37, #0, #37, text, #12',
    'depends-ON: #13',
    'Touches: scripts/inner-loop.mjs, apps/web/lib/, scripts/inner-loop.mjs',
    'touches: packages/shared/src',
  ].join('\n'));

  assert.deepEqual(hints.dependsOn, [37, 12, 13]);
  assert.deepEqual(hints.touches, ['scripts/inner-loop.mjs', 'apps/web/lib/', 'packages/shared/src']);
});

test('parseIssueRunHints: non-heading mentions are ignored', () => {
  const hints = parseIssueRunHints('Body text Depends-on: #1\n- Touches: scripts/x.mjs');
  assert.deepEqual(hints, { dependsOn: [], touches: [] });
});

test('pathsOverlap: exact and parent-child matches overlap only at segment boundaries', () => {
  assert.equal(pathsOverlap('apps/web/lib', './apps/web/lib/'), true);
  assert.equal(pathsOverlap('apps/web/lib', 'apps/web/lib/db.ts'), true);
  assert.equal(pathsOverlap('apps/web/liberation', 'apps/web/lib'), false);
  assert.equal(pathsOverlap('scripts/inner-loop.mjs', 'scripts/merge.mjs'), false);
});

test('parseInnerIssueWorktrees: extracts inner issue worktrees from git porcelain output', () => {
  const running = parseInnerIssueWorktrees([
    'worktree /repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/inner-issue-38',
    'HEAD def',
    'branch refs/heads/inner/issue-38',
    '',
    'worktree /tmp/other-worktree',
  ].join('\n'));

  assert.deepEqual([...running.entries()], [[38, '/repo/.claude/worktrees/inner-issue-38']]);
});

test('planDryRun: reports ready, dependency wait, touch conflict, running, and capacity', () => {
  const issues = [
    issue(1, 'Touches: scripts/a.mjs'),
    issue(2, 'Depends-on: #99\nTouches: scripts/b.mjs'),
    issue(3, 'Touches: scripts/a.mjs'),
    issue(4, 'Touches: scripts/c.mjs'),
    issue(5, 'Touches: scripts/d.mjs'),
  ];
  const states = new Map([[99, 'OPEN']]);
  const running = new Map([[4, '/repo/.claude/worktrees/inner-issue-4']]);

  const decisions = planDryRun({ issues, dependencyStates: states, runningWorktrees: running, max: 2 });

  assert.deepEqual(decisions.map((d) => d.status), [
    READY_NOW,
    WAIT_DEP,
    DEFER_TOUCHES,
    SKIP_RUNNING,
    DEFER_CAPACITY,
  ]);
  assert.equal(formatDecision(decisions[0]), 'READY_NOW #1');
  assert.equal(formatDecision(decisions[1]), 'WAIT_DEP #2 unresolved=#99');
  assert.equal(formatDecision(decisions[2]), 'DEFER_TOUCHES #3 overlaps=#1 path=scripts/a.mjs');
  assert.equal(formatDecision(decisions[3]), 'SKIP_RUNNING #4 worktree=/repo/.claude/worktrees/inner-issue-4');
  assert.equal(formatDecision(decisions[4]), 'DEFER_CAPACITY #5 max=2');
});

test('buildInnerLoopSpawnSpec: routes child stdout and stderr directly to the log fd', () => {
  const spec = buildInnerLoopSpawnSpec(issue(54), 123);

  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, ['scripts/inner-loop.mjs', '54']);
  assert.deepEqual(spec.options.stdio, ['ignore', 123, 123]);
  assert.equal(spec.options.env, process.env);
});

test('runQueue: unresolved dependency is not spawned in live mode', async () => {
  const spawned = [];
  const logs = [];
  const result = await runQueue({
    issues: [issue(10, 'Depends-on: #37\nTouches: scripts/x.mjs')],
    dependencyStates: new Map([[37, 'OPEN']]),
    runningWorktrees: new Map(),
    max: 2,
    spawnIssue: async (candidate) => {
      spawned.push(candidate.number);
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, []);
  assert.deepEqual(result.launched, []);
  assert.equal(result.failed, 0);
  assert.ok(logs.includes('WAIT_DEP #10 unresolved=#37'));
});

test('runQueue: circuit breaker stops dispatch after three consecutive failures', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    issues: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    dependencyStates: new Map(),
    runningWorktrees: new Map(),
    max: 1,
    spawnIssue: async (candidate) => {
      spawned.push(candidate.number);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, [1, 2, 3]);
  assert.deepEqual(result.launched, [1, 2, 3]);
  assert.equal(result.failed, 3);
  assert.ok(logs.includes('CIRCUIT_OPEN after 3 consecutive failures — dispatch halted'));
});

test('runQueue: circuit breaker stops dispatch before replenishing default parallelism', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    issues: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    dependencyStates: new Map(),
    runningWorktrees: new Map(),
    spawnIssue: async (candidate) => {
      spawned.push(candidate.number);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, [1, 2, 3]);
  assert.deepEqual(result.launched, [1, 2, 3]);
  assert.equal(result.failed, 3);
  assert.ok(logs.includes('CIRCUIT_OPEN after 3 consecutive failures — dispatch halted'));
});

test('runQueue: successful completion resets consecutive failure count', async () => {
  const statuses = new Map([
    [1, 1],
    [2, 0],
    [3, 1],
    [4, 1],
  ]);
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    issues: [issue(1), issue(2), issue(3), issue(4)],
    dependencyStates: new Map(),
    runningWorktrees: new Map(),
    max: 1,
    spawnIssue: async (candidate) => {
      spawned.push(candidate.number);
      return { status: statuses.get(candidate.number) };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, [1, 2, 3, 4]);
  assert.deepEqual(result.launched, [1, 2, 3, 4]);
  assert.equal(result.failed, 3);
  assert.ok(!logs.some((line) => line.startsWith('CIRCUIT_OPEN ')));
});

test('runQueue: maxFailures 0 disables the circuit breaker', async () => {
  const spawned = [];
  const logs = [];

  const result = await runQueue({
    issues: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    dependencyStates: new Map(),
    runningWorktrees: new Map(),
    max: 1,
    maxFailures: 0,
    spawnIssue: async (candidate) => {
      spawned.push(candidate.number);
      return { status: 1 };
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(spawned, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.launched, [1, 2, 3, 4, 5]);
  assert.equal(result.failed, 5);
  assert.ok(!logs.some((line) => line.startsWith('CIRCUIT_OPEN ')));
});

test('runQueue: overlapping Touches are not active at the same time and start after the blocker exits', async () => {
  const started = [];
  const resolvers = new Map();
  const active = new Set();
  const concurrentSnapshots = [];

  const queuePromise = runQueue({
    issues: [
      issue(1, 'Touches: scripts/a.mjs'),
      issue(2, 'Touches: scripts/a.mjs'),
      issue(3, 'Touches: scripts/b.mjs'),
    ],
    dependencyStates: new Map(),
    runningWorktrees: new Map(),
    max: 2,
    spawnIssue: (candidate) => {
      started.push(candidate.number);
      active.add(candidate.number);
      concurrentSnapshots.push([...active].sort((a, b) => a - b));
      return new Promise((resolve) => {
        resolvers.set(candidate.number, () => {
          active.delete(candidate.number);
          resolve({ status: 0 });
        });
      });
    },
  });

  await waitUntil(() => started.includes(1) && started.includes(3));
  assert.deepEqual(started, [1, 3]);
  assert.ok(!started.includes(2), 'issue #2 must wait while #1 with overlapping Touches is active');

  resolvers.get(1)();
  await waitUntil(() => started.includes(2));
  assert.deepEqual(started, [1, 3, 2]);
  assert.ok(
    concurrentSnapshots.every((snapshot) => !(snapshot.includes(1) && snapshot.includes(2))),
    'issues with overlapping Touches must not be active together',
  );

  resolvers.get(2)();
  resolvers.get(3)();
  const result = await queuePromise;
  assert.deepEqual(result.launched, [1, 3, 2]);
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
