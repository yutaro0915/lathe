import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addLocalTask,
  canonicalPhaseKey,
  classifyItems,
  createWbsRequestHandler,
  createEmptyTaskStore,
  inferRoadmapPhaseStatus,
  loadTaskStore,
  parseRoadmapPhases,
  parseDependencyRefs,
  renderBoard,
  saveTaskStore,
  setLocalTaskStatus,
  startWbsServer,
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

const ROADMAP_SAMPLE = [
  '# Roadmap',
  '',
  '### Phase 1 — 観測',
  '',
  '**Phase 1 完了の定義**:',
  '- [x] Transcript viewer',
  '- [x] Cost anomaly checks',
  '',
  '### Phase 2 — 分析の基盤',
  '',
  '**既達（基盤として最低限）**:',
  '- finding schema',
  '',
  '**現状**: **機構実証済み**。',
  '',
  '### Phase 2.5 — lathe エージェント動作の完成',
  '',
  '- [x] analyst submit',
  '- [ ] chat close',
  '',
  '### Phase 3 — 対照実験基盤',
  '',
  'Phase 3 開始ゲートで確定する。',
  '',
  '### Phase 1-6（dogfood 期）',
  '',
  'architecture-only heading, not a phase definition.',
  '',
  '### Phase 7+（OSS 公開期）',
  '',
  'architecture-only heading, not a phase definition.',
  '',
  '## Milestones',
].join('\n');

async function withTestServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await callback(baseUrl, server);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
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

test('roadmap parser extracts only em-dash phase definitions in order', () => {
  const phases = parseRoadmapPhases(ROADMAP_SAMPLE);

  assert.deepEqual(phases.map((phase) => phase.key), ['Phase 1', 'Phase 2', 'Phase 2.5', 'Phase 3']);
  assert.deepEqual(phases.map((phase) => phase.title), [
    'Phase 1 — 観測',
    'Phase 2 — 分析の基盤',
    'Phase 2.5 — lathe エージェント動作の完成',
    'Phase 3 — 対照実験基盤',
  ]);
  assert.deepEqual(phases.map((phase) => phase.status), ['done', 'done', 'in-progress', 'todo']);
});

test('canonicalPhaseKey normalizes phase free text and excludes architecture headings', () => {
  assert.equal(canonicalPhaseKey('Phase 2'), 'Phase 2');
  assert.equal(canonicalPhaseKey('Phase 2: AI analysis'), 'Phase 2');
  assert.equal(canonicalPhaseKey('Phase 2 — 分析の基盤'), 'Phase 2');
  assert.equal(canonicalPhaseKey('Phase 2.5 — lathe agent'), 'Phase 2.5');
  assert.equal(canonicalPhaseKey('Phase 1-6（dogfood 期）'), null);
  assert.equal(canonicalPhaseKey('Phase 7+（OSS 公開期）'), null);
  assert.equal(canonicalPhaseKey('analysis backlog'), null);
});

test('roadmap status stays conservative when done-like signals still list remaining work', () => {
  assert.equal(
    inferRoadmapPhaseStatus('**現状**: 基盤は機構実証済み（上記）。残 = chat / 採否ループ。', 'Phase 2.5'),
    'in-progress',
  );
});

test('classifyItems seeds roadmap phases and groups phase variants by canonical key', () => {
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
        title: 'Phase 2 umbrella',
        description: 'Track the big phase before GitHub issues exist.',
        status: 'todo',
        phase: 'Phase 2 — 分析の基盤',
        deps: [],
      },
      {
        id: 'unscoped',
        title: 'Unscoped note',
        description: 'Keep free-form phase buckets working.',
        status: 'todo',
        phase: 'Ad hoc lane',
        deps: [],
      },
    ],
    runningWorktrees: new Map(),
    manifests: new Map(),
    roadmapText: ROADMAP_SAMPLE,
  });

  assert.deepEqual(classified.phases.map((phase) => phase.key), [
    'Phase 1',
    'Phase 2',
    'Phase 2.5',
    'Phase 3',
    'Ad hoc lane',
  ]);
  assert.equal(classified.phases[0].status, 'done');
  assert.equal(classified.phases[0].sections.ready.length, 0);

  const phase2 = classified.phases.find((phase) => phase.key === 'Phase 2');
  assert.equal(phase2.title, 'Phase 2 — 分析の基盤');
  assert.equal(phase2.status, 'done');
  assert.equal(phase2.sections.ready[0].ref, 'task:phase2');
  assert.equal(phase2.sections.needsPlan[0].ref, 'issue:21');

  const board = renderBoard(classified);
  assert.match(board, /## Phase: Phase 1 — 観測 \[done\] \(0\/0 done\)/);
  assert.match(board, /## Phase: Phase 2 — 分析の基盤 \[done\] \(0\/2 done\)/);
  assert.match(board, /## Phase: Ad hoc lane \(0\/1 done\)/);

  const json = toJson(classified);
  assert.equal(json.phases[1].key, 'Phase 2');
  assert.equal(json.phases[1].title, 'Phase 2 — 分析の基盤');
  assert.equal(json.phases[1].status, 'done');
  assert.equal(json.phases[1].sections.ready[0].phase, 'Phase 2');
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

  const phase2 = classified.phases.find((phase) => phase.key === 'Phase 2');
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
    roadmapText: ROADMAP_SAMPLE,
  });

  const board = renderBoard(classified);
  assert.match(board, /# WBS/);
  assert.match(board, /## Phase: Phase 2 — 分析の基盤 \[done\] \(0\/2 done\)/);
  assert.match(board, /### READY \(1\)/);
  assert.match(board, /task:phase2 Phase 2: AI analysis/);
  assert.match(board, /つまり: Track the big phase before GitHub issues exist\./);
  assert.match(board, /issue:21 Plan analyst engine/);
  assert.match(board, /つまり: Draft the analyst engine before implementation\./);

  const json = toJson(classified);
  const phase2 = json.phases.find((phase) => phase.key === 'Phase 2');
  assert.equal(phase2.title, 'Phase 2 — 分析の基盤');
  assert.equal(phase2.status, 'done');
  assert.equal(phase2.sections.ready[0].kind, 'task');
  assert.equal(phase2.sections.needs_plan[0].kind, 'issue');
});

test('serve: renders an htmx-backed HTML board with phase groups and local htmx asset', async () => {
  const path = tmpStorePath();
  try {
    saveTaskStore(path, {
      version: 1,
      tasks: [
        {
          id: 'phase2',
          title: 'Phase 2 umbrella',
          description: 'Track the phase before GitHub issues exist.',
          status: 'todo',
          phase: 'Phase 2: AI analysis',
          deps: [],
        },
        {
          id: 'blocked-followup',
          title: 'Blocked follow-up',
          description: 'Wait for analyst plan.',
          status: 'todo',
          phase: 'Phase 2: AI analysis',
          deps: ['issue:21'],
        },
        {
          id: 'done-note',
          title: 'Completed note',
          description: 'Already done.',
          status: 'done',
          phase: 'Phase 2: AI analysis',
          deps: [],
        },
      ],
    });

    const handler = createWbsRequestHandler({
      taskFilePath: path,
      cacheTtlMs: 60_000,
      roadmapTextProvider: () => ROADMAP_SAMPLE,
      issuesProvider: () => [
        issue(21, 'Plan analyst engine', {
          labels: [{ name: 'needs-plan' }],
          body: 'Draft the analyst engine before implementation.',
          milestone: { title: 'Phase 2: AI analysis' },
        }),
      ],
      worktreeProvider: () => new Map(),
      manifestsProvider: () => new Map(),
    });

    await withTestServer(handler, async (baseUrl) => {
      const page = await fetch(`${baseUrl}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const html = await page.text();
      assert.match(html, /<script src="\/htmx\.min\.js"><\/script>/);
      assert.match(html, /hx-get="\/board"/);
      assert.match(html, /Phase: Phase 1 — 観測[\s\S]*<span class="phase-status phase-status--done">done<\/span>[\s\S]*<span class="phase-progress">0\/0 done<\/span>/);
      assert.match(html, /Phase: Phase 2 — 分析の基盤[\s\S]*<span class="phase-status phase-status--done">done<\/span>[\s\S]*<span class="phase-progress">1\/4 done<\/span>/);
      assert.match(html, /Phase: Phase 3 — 対照実験基盤[\s\S]*<span class="phase-status phase-status--todo">todo<\/span>/);
      assert.match(html, /\.layout \{\n\s+display: grid;\n\s+gap: 12px;\n\s+width: 100%;\n\s+max-width: none;/);
      assert.match(html, /<div class="phase-root" aria-label="Phase parent breakdown">[\s\S]*<span class="phase-progress">1\/4 done<\/span>/);
      assert.match(html, /<div class="phase-bar" aria-hidden="true"><span style="width:25%"><\/span><\/div>/);
      assert.match(html, /<div class="phase-flow" aria-label="Left-to-right work lifecycle">/);
      assert.doesNotMatch(html, /<section class="lane[^"]*lane--running"[^>]*data-state="running"/);
      assert.match(html, /data-flow-step="3" data-state="ready"[\s\S]*data-flow-step="4" data-state="waitDep"[\s\S]*data-flow-step="5" data-state="needsPlan"[\s\S]*data-flow-step="7" data-state="doneRecent"/);
      assert.match(html, /READY/);
      assert.match(html, /NEEDS-PLAN/);
      assert.doesNotMatch(html, /つまり:/);
      assert.doesNotMatch(html, /Track the phase before GitHub issues exist\./);
      assert.doesNotMatch(html, /Draft the analyst engine before implementation\./);
      assert.doesNotMatch(html, /status: todo/);
      assert.match(html, /<span class="meta-chip meta-chip--dep">depends: issue:21<\/span>/);
      assert.match(html, /<a class="item item--issue item--needs-plan item-link" href="https:\/\/github\.com\/yutaro0915\/lathe\/issues\/21" target="_blank" rel="noreferrer"/);
      assert.doesNotMatch(html, /<div class="item-line">/);
      assert.match(html, /<article class="item item--task item--ready">\n<div class="item-meta-row">[\s\S]*<span class="item-ref">task:phase2<\/span>[\s\S]*<div class="task-actions" aria-label="Change task status">[\s\S]*<\/div><\/div>\n<div class="item-title-row"><span class="item-title">Phase 2 umbrella<\/span><\/div>/);
      assert.match(html, /<div class="item-meta-row">[^\n]*<span class="item-ref">issue:21<\/span>[^\n]*<\/div>\n<div class="item-title-row"><span class="item-title">Plan analyst engine<\/span><\/div>/);
      assert.match(html, /<span class="state-badge state-badge--ready" title="READY" aria-label="READY"><span class="state-dot"><\/span><span class="state-code">READY<\/span><\/span>/);
      assert.match(html, /<div class="task-actions" aria-label="Change task status">[\s\S]*<button type="submit">doing<\/button>[\s\S]*<button type="submit">done<\/button>[\s\S]*<\/div>/);
      assert.doesNotMatch(html, /<button type="submit" disabled>todo<\/button>/);

      const htmx = await fetch(`${baseUrl}/htmx.min.js`);
      assert.equal(htmx.status, 200);
      assert.match(htmx.headers.get('content-type'), /javascript/);
      assert.match(await htmx.text(), /htmx/i);

      const htmxHead = await fetch(`${baseUrl}/htmx.min.js`, { method: 'HEAD' });
      assert.equal(htmxHead.status, 200);
      assert.match(htmxHead.headers.get('content-type'), /javascript/);
    });
  } finally {
    rmSync(join(path, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('serve: issue cards are whole-card links and summaries are omitted from cards', async () => {
  const path = tmpStorePath();
  try {
    saveTaskStore(path, {
      version: 1,
      tasks: [
        {
          id: 'local-ready',
          title: 'Local ready task',
          description: 'Do not render this local task card description.',
          status: 'todo',
          phase: null,
          deps: [],
        },
      ],
    });

    const handler = createWbsRequestHandler({
      taskFilePath: path,
      cacheTtlMs: 60_000,
      roadmapTextProvider: () => null,
      issuesProvider: () => [
        issue(52, 'Clickable issue card', {
          labels: [{ name: 'inner-loop' }],
          body: 'Depends-on: none\n\nDo not render this issue body summary.',
          milestone: null,
        }),
      ],
      worktreeProvider: () => new Map(),
      manifestsProvider: () => new Map(),
      githubRepoUrl: 'https://github.example.test/acme/repo',
    });

    await withTestServer(handler, async (baseUrl) => {
      const page = await fetch(`${baseUrl}/board`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Phase: Unphased/);
      assert.match(html, /<a class="item item--issue item--ready item-link" href="https:\/\/github\.example\.test\/acme\/repo\/issues\/52" target="_blank" rel="noreferrer"/);
      assert.match(html, /<span class="item-ref">issue:52<\/span>/);
      assert.match(html, /<article class="item item--task item--ready">/);
      assert.match(html, /<span class="phase-progress">0\/2 done<\/span>/);
      assert.doesNotMatch(html, /つまり:/);
      assert.doesNotMatch(html, /Do not render this issue body summary\./);
      assert.doesNotMatch(html, /Do not render this local task card description\./);
    });
  } finally {
    rmSync(join(path, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('serve: adds a local task and updates status without writing to GitHub', async () => {
  const path = tmpStorePath();
  let issuesReads = 0;
  try {
    const handler = createWbsRequestHandler({
      taskFilePath: path,
      cacheTtlMs: 60_000,
      roadmapTextProvider: () => null,
      issuesProvider: () => {
        issuesReads += 1;
        return [
          issue(31, 'Plan next slice', {
            labels: [{ name: 'needs-plan' }],
            body: 'Create the plan before implementation.',
            milestone: { title: 'Phase 2: AI analysis' },
          }),
        ];
      },
      worktreeProvider: () => new Map(),
      manifestsProvider: () => new Map(),
    });

    await withTestServer(handler, async (baseUrl) => {
      const add = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          id: 'web-ui',
          title: 'Wire WBS UI',
          description: 'Expose local task edits through serve mode.',
          phase: 'Phase 2: AI analysis',
          depends: '',
        }),
      });
      assert.equal(add.status, 200);
      assert.match(await add.text(), /task:web-ui/);
      assert.equal(loadTaskStore(path).tasks[0].status, 'todo');

      const doing = await fetch(`${baseUrl}/tasks/web-ui/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ status: 'doing' }),
      });
      assert.equal(doing.status, 200);
      assert.match(await doing.text(), /RUNNING 1/);
      assert.equal(loadTaskStore(path).tasks[0].status, 'doing');

      const done = await fetch(`${baseUrl}/tasks/web-ui/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ status: 'done' }),
      });
      assert.equal(done.status, 200);
      assert.match(await done.text(), /DONE \(recent\) 1/);
      assert.equal(loadTaskStore(path).tasks[0].status, 'done');
    });

    assert.equal(issuesReads, 1);
  } finally {
    rmSync(join(path, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('serve: reuses cached issue data across board polls within the TTL', async () => {
  const path = tmpStorePath();
  let issuesReads = 0;
  try {
    const handler = createWbsRequestHandler({
      taskFilePath: path,
      cacheTtlMs: 60_000,
      roadmapTextProvider: () => null,
      issuesProvider: () => {
        issuesReads += 1;
        return [issue(44, 'Cached issue', { labels: [{ name: 'inner-loop' }], body: 'Depends-on: none' })];
      },
      worktreeProvider: () => new Map(),
      manifestsProvider: () => new Map(),
    });

    await withTestServer(handler, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/board`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/board`)).status, 200);
    });

    assert.equal(issuesReads, 1);
  } finally {
    rmSync(join(path, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('serve: startWbsServer binds only to 127.0.0.1', async () => {
  const started = await startWbsServer({
    port: 0,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
  });
  try {
    assert.equal(started.host, '127.0.0.1');
    assert.equal(started.server.address().address, '127.0.0.1');
    assert.equal((await fetch(`${started.url}/`)).status, 200);
  } finally {
    await new Promise((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
