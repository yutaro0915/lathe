import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addLocalTask,
  classifyItems,
  createEmptyTaskStore,
  loadTaskStore,
  parseDependencyRefs,
  renderBoard,
  saveTaskStore,
  setLocalTaskStatus,
  toJson,
} from './wbs.mjs';

function tmpStorePath() {
  return join(mkdtempSync(join(tmpdir(), 'lathe-wbs-')), '.lathe', 'wbs', 'tasks.json');
}

function issue(number, title, overrides = {}) {
  return {
    number,
    title,
    state: 'OPEN',
    labels: [],
    body: '',
    milestone: null,
    ...overrides,
  };
}

test('task store: missing file loads empty and save creates .lathe/wbs/tasks.json', () => {
  const path = tmpStorePath();
  try {
    assert.deepEqual(loadTaskStore(path), createEmptyTaskStore());

    const store = addLocalTask(createEmptyTaskStore(), {
      id: 'phase2',
      title: 'Phase 2: AI analysis',
      description: 'Build the analysis phase umbrella and track its blockers.',
      status: 'todo',
      phase: 'Phase 2: AI analysis',
      deps: ['#12', 'task:review-rubric'],
      now: '2026-07-04T00:00:00.000Z',
    });
    saveTaskStore(path, store);

    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.tasks[0].id, 'phase2');
    assert.deepEqual(raw.tasks[0].deps, ['issue:12', 'task:review-rubric']);
  } finally {
    rmSync(join(path, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('task store: status command updates only the requested local task', () => {
  const store = addLocalTask(createEmptyTaskStore(), {
    id: 'memo',
    title: 'Supervisor memo',
    description: 'Capture cross-issue supervision notes.',
    status: 'todo',
    phase: 'Phase 2',
    deps: [],
    now: '2026-07-04T00:00:00.000Z',
  });

  const updated = setLocalTaskStatus(store, 'memo', 'done', '2026-07-04T01:00:00.000Z');
  assert.equal(updated.tasks[0].status, 'done');
  assert.equal(updated.tasks[0].updatedAt, '2026-07-04T01:00:00.000Z');
  assert.throws(() => setLocalTaskStatus(updated, 'missing', 'done'), /unknown task id: missing/);
});

test('dependency parser accepts task refs and GitHub issue refs', () => {
  assert.deepEqual(parseDependencyRefs(['task:phase2', '#19, issue:22', '23']), [
    'task:phase2',
    'issue:19',
    'issue:22',
    'issue:23',
  ]);
});

test('classifyItems: integrates issues and local tasks with pending approval and cross-dependencies', () => {
  const issues = [
    issue(10, 'Implement transcript panel', {
      labels: [{ name: 'inner-loop' }],
      body: 'Depends-on: none\n\nShow transcript turns with analysis affordances.',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
    issue(11, 'Needs approval', {
      labels: [{ name: 'inner-loop' }, { name: 'pending-approval' }],
      body: 'Human has to approve the implementation plan before run.',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
    issue(12, 'Blocked issue', {
      labels: [{ name: 'inner-loop' }],
      body: 'Depends-on: #99',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
    issue(13, 'Needs plan issue', {
      labels: [{ name: 'needs-plan' }],
      body: 'Turn the rough request into an implementable plan.',
      milestone: { title: 'Phase 2: AI analysis' },
    }),
    issue(14, 'Ready issue', {
      labels: [{ name: 'inner-loop' }],
      body: 'Depends-on: none\n\nReady for the next inner-loop run.',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
    issue(99, 'Open blocker', {
      body: 'Existing blocker.',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
    issue(8, 'Recently merged issue', {
      state: 'CLOSED',
      body: 'Landed last week.',
      milestone: { title: 'Phase 1: transcript analysis' },
    }),
  ];

  const store = {
    version: 1,
    tasks: [
      {
        id: 'phase2-ai',
        title: 'Phase 2: AI analysis',
        description: 'Umbrella task for AI analysis work.',
        status: 'doing',
        phase: 'Phase 2: AI analysis',
        deps: [],
      },
      {
        id: 'rubric-review',
        title: 'Review analysis rubric',
        description: 'Check the draft rubric before issue execution starts.',
        status: 'todo',
        phase: 'Phase 2: AI analysis',
        deps: ['issue:13'],
      },
      {
        id: 'closed-note',
        title: 'Close supervision note',
        description: 'Archive the completed supervision memo.',
        status: 'done',
        phase: 'Phase 2: AI analysis',
        deps: [],
      },
    ],
  };

  const classified = classifyItems({
    issues,
    localTasks: store.tasks,
    runningWorktrees: new Map([[10, '/repo/.claude/worktrees/inner-issue-10']]),
    manifests: new Map(),
  });

  assert.deepEqual(classified.totals, {
    running: 2,
    pendingApproval: 1,
    ready: 1,
    waitDep: 2,
    needsPlan: 1,
    unqueued: 1,
    doneRecent: 2,
  });

  const phase2 = classified.phases.find((phase) => phase.phase === 'Phase 2: AI analysis');
  assert.ok(phase2);
  assert.equal(phase2.sections.running[0].ref, 'task:phase2-ai');
  assert.equal(phase2.sections.waitDep[0].ref, 'task:rubric-review');
  assert.deepEqual(phase2.sections.waitDep[0].waitingOn, ['issue:13']);
});

test('renderBoard: groups items by phase and displays plain-language summaries', () => {
  const classified = classifyItems({
    issues: [
      issue(21, 'Plan analyst engine', {
        labels: [{ name: 'needs-plan' }],
        body: '# Context\n\nDraft the analyst engine before implementation.',
        milestone: { title: 'Phase 2: AI analysis' },
      }),
    ],
    localTasks: [
      {
        id: 'phase2',
        title: 'Phase 2: AI analysis',
        description: 'Track the big phase before GitHub issues exist.',
        status: 'todo',
        phase: 'Phase 2: AI analysis',
        deps: [],
      },
    ],
    runningWorktrees: new Map(),
    manifests: new Map(),
  });

  const board = renderBoard(classified);
  assert.match(board, /# WBS/);
  assert.match(board, /## Phase: Phase 2: AI analysis/);
  assert.match(board, /### READY \(1\)/);
  assert.match(board, /task:phase2 Phase 2: AI analysis/);
  assert.match(board, /つまり: Track the big phase before GitHub issues exist\./);
  assert.match(board, /issue:21 Plan analyst engine/);
  assert.match(board, /つまり: Draft the analyst engine before implementation\./);

  const json = toJson(classified);
  assert.equal(json.phases[0].sections.ready[0].kind, 'task');
  assert.equal(json.phases[0].sections.needs_plan[0].kind, 'issue');
});
