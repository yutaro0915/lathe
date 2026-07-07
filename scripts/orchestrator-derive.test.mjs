// Tests for the orchestrator snapshot layer (#201 分解 7): GraphQL data →
// normalized snapshot, Status field name resolution (no hardcoded option ids),
// review-record / 教材 derivation inputs, and fail-closed blocked-by refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefStatesQuery,
  collectOutsideRefs,
  deriveSnapshot,
  isDriverPrBranch,
  normalizeIssue,
  normalizePr,
  normalizeSnapshot,
  parseRefStates,
  resolveStatusField,
  REPO_NAME,
  REPO_OWNER,
} from './orchestrator-derive.mjs';
import { PROJECTS_PROJECT_ID } from './inner-loop-projects.mjs';

// --- fixtures ---

function projectNodeFixture() {
  return {
    field: {
      id: 'FIELD_ID_1',
      name: 'Status',
      options: [
        { id: 'opt-backlog', name: 'Backlog' },
        { id: 'opt-approval', name: 'Approval' },
        { id: 'opt-ready', name: 'Ready' },
        { id: 'opt-escalated', name: 'Escalated' },
      ],
    },
  };
}

function issueNodeFixture(overrides = {}) {
  return {
    number: 204,
    title: 'feat(orchestrator): derive',
    body: 'Generated from #201\nblocked-by #201',
    labels: { nodes: [{ name: 'task-request' }, { name: 'needs-review' }] },
    projectItems: {
      nodes: [
        { id: 'ITEM_OTHER', project: { id: 'PVT_other' }, fieldValueByName: { optionId: 'x', name: 'Done' } },
        { id: 'ITEM_204', project: { id: PROJECTS_PROJECT_ID }, fieldValueByName: { optionId: 'opt-ready', name: 'Ready' } },
      ],
    },
    ...overrides,
  };
}

function prNodeFixture(overrides = {}) {
  return {
    number: 300,
    title: 'fix: something',
    body: 'Closes #42',
    isDraft: false,
    headRefName: 'hotfix/board-ids',
    url: 'https://example.invalid/pr/300',
    comments: { nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

// --- resolveStatusField（名前解決 — id 直書き禁止の恒久対処） ---

test('resolveStatusField: resolves option ids by name from the project node', () => {
  const field = resolveStatusField(projectNodeFixture());
  assert.equal(field.fieldId, 'FIELD_ID_1');
  assert.equal(field.options.Ready, 'opt-ready');
  assert.equal(field.options.Escalated, 'opt-escalated');
  assert.equal(field.options.Approval, 'opt-approval');
});

test('resolveStatusField: returns null when the field cannot be resolved', () => {
  assert.equal(resolveStatusField(null), null);
  assert.equal(resolveStatusField({}), null);
  assert.equal(resolveStatusField({ field: { id: 'F', options: null } }), null);
});

// --- normalizeIssue ---

test('normalizeIssue: labels, blocked-by refs, and project-#2 status by name', () => {
  const issue = normalizeIssue(issueNodeFixture());
  assert.equal(issue.number, 204);
  assert.deepEqual(issue.labels, ['task-request', 'needs-review']);
  assert.deepEqual(issue.blockedBy, [201]);
  assert.equal(issue.projectItemId, 'ITEM_204', 'must pick the item of project #2, not other projects');
  assert.equal(issue.statusName, 'Ready');
});

test('normalizeIssue: an issue off the board has null projectItemId / statusName', () => {
  const issue = normalizeIssue(issueNodeFixture({ projectItems: { nodes: [] } }));
  assert.equal(issue.projectItemId, null);
  assert.equal(issue.statusName, null);
});

// --- normalizePr / isDriverPrBranch ---

test('isDriverPrBranch: only inner/issue-<n> branches are driver PRs', () => {
  assert.equal(isDriverPrBranch('inner/issue-42'), true);
  assert.equal(isDriverPrBranch('inner/issue-'), false);
  assert.equal(isDriverPrBranch('hotfix/x'), false);
  assert.equal(isDriverPrBranch(null), false);
});

test('normalizePr: review record derives from ## REVIEW: heading or engine marker', () => {
  const bare = normalizePr(prNodeFixture());
  assert.equal(bare.hasReviewRecord, false);
  assert.equal(bare.isDriverPr, false);

  const reviewed = normalizePr(prNodeFixture({
    comments: { nodes: [{ body: '<!-- lathe-review-engine -->\n## REVIEW: PASS\n\nok' }] },
  }));
  assert.equal(reviewed.hasReviewRecord, true);

  const reviewedByReview = normalizePr(prNodeFixture({
    reviews: { nodes: [{ body: '## REVIEW: CHANGES\n…' }] },
  }));
  assert.equal(reviewedByReview.hasReviewRecord, true);

  const driverPr = normalizePr(prNodeFixture({ headRefName: 'inner/issue-7' }));
  assert.equal(driverPr.isDriverPr, true);
});

// --- normalizeSnapshot ---

test('normalizeSnapshot: sorts issues/PRs ascending and keeps warnings empty on a clean page', () => {
  const data = {
    node: projectNodeFixture(),
    repository: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [issueNodeFixture({ number: 210 }), issueNodeFixture({ number: 204 })] },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [prNodeFixture({ number: 302 }), prNodeFixture({ number: 301 })] },
    },
  };
  const snapshot = normalizeSnapshot(data);
  assert.deepEqual(snapshot.issues.map((i) => i.number), [204, 210]);
  assert.deepEqual(snapshot.prs.map((p) => p.number), [301, 302]);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.statusField.options.Backlog, 'opt-backlog');
});

test('normalizeSnapshot: unresolved Status field and truncated pages are warned, not fatal', () => {
  const data = {
    node: null,
    repository: {
      issues: { pageInfo: { hasNextPage: true }, nodes: [] },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    },
  };
  const snapshot = normalizeSnapshot(data);
  assert.equal(snapshot.statusField, null);
  assert.equal(snapshot.warnings.length, 2);
});

// --- blocked-by 集合外参照 ---

test('collectOutsideRefs: only refs outside the open-issue set, deduped and sorted', () => {
  const issues = [
    { number: 10, blockedBy: [] },
    { number: 11, blockedBy: [10, 99] },
    { number: 12, blockedBy: [99, 42] },
  ];
  assert.deepEqual(collectOutsideRefs(issues), [42, 99]);
});

test('buildRefStatesQuery / parseRefStates: aliased batch; missing node is open (fail-closed)', () => {
  const query = buildRefStatesQuery([42, 99]);
  assert.match(query, /r42: issue\(number: 42\) \{ number state \}/);
  assert.match(query, /r99: issue\(number: 99\) \{ number state \}/);

  const open = parseRefStates({
    repository: {
      r42: { number: 42, state: 'CLOSED' },
      r99: null, // 削除・移管などで解決できない参照
    },
  }, [42, 99]);
  assert.deepEqual(open, [99], 'closed ref resolved; unresolvable ref stays blocking');
});

// --- deriveSnapshot（side effect 面・spawnSync 注入） ---

function fakeGh(responses) {
  let call = 0;
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return r;
  };
  return { run, calls };
}

test('deriveSnapshot: one batched query; no ref query when all refs are inside the open set', () => {
  const data = {
    node: projectNodeFixture(),
    repository: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [issueNodeFixture({ number: 201, body: 'root' }), issueNodeFixture({ number: 204 })] },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    },
  };
  const { run, calls } = fakeGh([{ status: 0, stdout: JSON.stringify({ data }) }]);
  const result = deriveSnapshot({ spawnSync: run });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, '#204 の blocked-by #201 は open 集合内 — ref query 不要');
  assert.deepEqual(result.snapshot.openBlockerRefs, []);
  assert.equal(calls[0].args[0], 'api');
  assert.ok(calls[0].args.some((a) => a === `owner=${REPO_OWNER}`));
  assert.ok(calls[0].args.some((a) => a === `repo=${REPO_NAME}`));
});

test('deriveSnapshot: outside refs resolved by a second batch; failure falls back fail-closed', () => {
  const data = {
    node: projectNodeFixture(),
    repository: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [issueNodeFixture({ number: 204, body: 'blocked-by #99' })] },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    },
  };
  const okRefs = { data: { repository: { r99: { number: 99, state: 'OPEN' } } } };
  const good = fakeGh([
    { status: 0, stdout: JSON.stringify({ data }) },
    { status: 0, stdout: JSON.stringify(okRefs) },
  ]);
  const result = deriveSnapshot({ spawnSync: good.run });
  assert.equal(good.calls.length, 2);
  assert.deepEqual(result.snapshot.openBlockerRefs, [99]);

  const failing = fakeGh([
    { status: 0, stdout: JSON.stringify({ data }) },
    { status: 1, stdout: '', stderr: 'boom' },
  ]);
  const fallback = deriveSnapshot({ spawnSync: failing.run });
  assert.deepEqual(fallback.snapshot.openBlockerRefs, [99], 'query 失敗時は集合外参照を open 扱い');
  assert.ok(fallback.snapshot.warnings.some((w) => w.includes('fail-closed')));
});

test('deriveSnapshot: snapshot query failure is reported, not thrown', () => {
  const { run } = fakeGh([{ status: 1, stdout: '', stderr: 'rate limited' }]);
  const result = deriveSnapshot({ spawnSync: run });
  assert.equal(result.ok, false);
  assert.match(result.reason, /rate limited/);
});
