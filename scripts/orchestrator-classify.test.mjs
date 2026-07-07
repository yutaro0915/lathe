// Tests for the deterministic work-assignment rules (#201 分解 8).
// 全クラスの表駆動 + 判定順（escalation → running → PR 参照 → dep → plan →
// needs-review 分岐 → 無印実装）と classifyAll の決定的順序を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PLAN, CLASS_PR_REVIEW,
  SKIP_DRAFT, SKIP_DRIVER_PR, SKIP_NON_TASK, SKIP_REVIEWED,
  WAIT_APPROVAL, WAIT_DEP, WAIT_ESCALATION, WAIT_PR, WAIT_RUNNING,
  STATUS_APPROVAL, STATUS_ESCALATED, STATUS_READY,
  classifyAll, classifyIssue, classifyPr, formatDecision, isDispatchClass,
  planBoardProjection,
} from './orchestrator-classify.mjs';

function issueState(overrides = {}) {
  return {
    number: 100,
    title: 't',
    body: '',
    labels: ['task-request'],
    blockedBy: [],
    projectItemId: 'ITEM_100',
    statusName: 'Backlog',
    ...overrides,
  };
}

function prState(overrides = {}) {
  return {
    number: 300,
    title: 'p',
    body: '',
    isDraft: false,
    headRefName: 'feat/x',
    url: '',
    isDriverPr: false,
    hasReviewRecord: false,
    ...overrides,
  };
}

const emptyCtx = {
  openIssueNumbers: new Set(),
  inProgressIssueNumbers: new Set(),
  runningIssueNumbers: new Set(),
};

// --- classifyIssue: 表駆動（全クラス） ---

const ISSUE_TABLE = [
  {
    name: 'task-request なし → SKIP_NON_TASK',
    issue: issueState({ labels: [] }),
    ctx: emptyCtx,
    expected: SKIP_NON_TASK,
  },
  {
    name: 'escalation label → WAIT_ESCALATION（最優先・他条件より先）',
    issue: issueState({ labels: ['task-request', 'escalation', 'needs-plan'], blockedBy: [1] }),
    ctx: { ...emptyCtx, openIssueNumbers: new Set([1]) },
    expected: WAIT_ESCALATION,
  },
  {
    name: '実行中（live マーカー） → WAIT_RUNNING（dep より先）',
    issue: issueState({ blockedBy: [1] }),
    ctx: { ...emptyCtx, openIssueNumbers: new Set([1]), runningIssueNumbers: new Set([100]) },
    expected: WAIT_RUNNING,
  },
  {
    name: 'open PR 参照 → WAIT_PR（In Progress、ADR 0031 §2）',
    issue: issueState(),
    ctx: { ...emptyCtx, inProgressIssueNumbers: new Set([100]) },
    expected: WAIT_PR,
  },
  {
    name: 'blocked-by が open → WAIT_DEP',
    issue: issueState({ blockedBy: [1, 2] }),
    ctx: { ...emptyCtx, openIssueNumbers: new Set([2]) },
    expected: WAIT_DEP,
  },
  {
    name: 'needs-plan → PLAN（plan 未確定）',
    issue: issueState({ labels: ['task-request', 'needs-plan', 'needs-review'] }),
    ctx: emptyCtx,
    expected: CLASS_PLAN,
  },
  {
    name: 'needs-review × 教材なし → EXPLAIN',
    issue: issueState({ labels: ['task-request', 'needs-review'] }),
    ctx: emptyCtx,
    expected: CLASS_EXPLAIN,
  },
  {
    name: 'needs-review × 教材あり × 非 Ready → WAIT_APPROVAL',
    issue: issueState({ labels: ['task-request', 'needs-review', 'done-explain'], statusName: 'Approval' }),
    ctx: emptyCtx,
    expected: WAIT_APPROVAL,
  },
  {
    name: 'needs-review × Ready → IMPLEMENT（承認済み・教材有無に依らない）',
    issue: issueState({ labels: ['task-request', 'needs-review'], statusName: STATUS_READY }),
    ctx: emptyCtx,
    expected: CLASS_IMPLEMENT,
  },
  {
    name: '無印 → IMPLEMENT（plan review PASS は driver run 内で強制）',
    issue: issueState(),
    ctx: emptyCtx,
    expected: CLASS_IMPLEMENT,
  },
];

for (const row of ISSUE_TABLE) {
  test(`classifyIssue: ${row.name}`, () => {
    const decision = classifyIssue(row.issue, row.ctx);
    assert.equal(decision.class, row.expected);
  });
}

test('classifyIssue: WAIT_DEP carries the unresolved refs', () => {
  const decision = classifyIssue(
    issueState({ blockedBy: [1, 2, 3] }),
    { ...emptyCtx, openIssueNumbers: new Set([1, 3]) },
  );
  assert.deepEqual(decision.unresolved, [1, 3]);
});

test('classifyIssue: labels are matched case-insensitively', () => {
  const decision = classifyIssue(issueState({ labels: ['Task-Request', 'Needs-Plan'] }), emptyCtx);
  assert.equal(decision.class, CLASS_PLAN);
});

test('classifyIssue: needs-review × explains/ 正本あり（label なし）→ WAIT_APPROVAL（#201 分解 13 重複生成防止）', () => {
  const issue = issueState({ labels: ['task-request', 'needs-review'] });
  const decision = classifyIssue(issue, { ...emptyCtx, explainedIssueNumbers: new Set([100]) });
  assert.equal(decision.class, WAIT_APPROVAL);
  assert.match(decision.reason, /explains\/ 正本/, '証拠の種別を reason に出す');
});

// --- classifyPr: 表駆動（全クラス） ---

const PR_TABLE = [
  {
    name: '実行中（live マーカー） → WAIT_RUNNING',
    pr: prState(),
    ctx: { runningPrNumbers: new Set([300]) },
    expected: WAIT_RUNNING,
  },
  { name: 'draft → SKIP_DRAFT', pr: prState({ isDraft: true }), ctx: {}, expected: SKIP_DRAFT },
  {
    name: 'driver 産（inner/issue-<n>） → SKIP_DRIVER_PR',
    pr: prState({ isDriverPr: true, headRefName: 'inner/issue-7' }),
    ctx: {},
    expected: SKIP_DRIVER_PR,
  },
  {
    name: 'review 記録あり → SKIP_REVIEWED',
    pr: prState({ hasReviewRecord: true }),
    ctx: {},
    expected: SKIP_REVIEWED,
  },
  {
    name: '非 driver 産 × 記録なし → PR_REVIEW',
    pr: prState(),
    ctx: {},
    expected: CLASS_PR_REVIEW,
  },
];

for (const row of PR_TABLE) {
  test(`classifyPr: ${row.name}`, () => {
    assert.equal(classifyPr(row.pr, row.ctx).class, row.expected);
  });
}

// --- classifyAll ---

test('classifyAll: deterministic order (issues asc then PRs asc), In Progress derived from PRs', () => {
  const snapshot = {
    issues: [
      issueState({ number: 12 }),
      issueState({ number: 10 }),
      issueState({ number: 11, blockedBy: [10] }),
    ],
    prs: [
      prState({ number: 301, body: 'Closes #12' }),
      prState({ number: 300, headRefName: 'inner/issue-9', isDriverPr: true }),
    ],
    openBlockerRefs: [],
  };
  const decisions = classifyAll(snapshot);
  assert.deepEqual(
    decisions.map((d) => `${d.kind}:${d.number}:${d.class}`),
    [
      `issue:10:${CLASS_IMPLEMENT}`,
      `issue:11:${WAIT_DEP}`, // #10 が open 集合内
      `issue:12:${WAIT_PR}`, // PR #301 が Closes #12
      `pr:300:${SKIP_DRIVER_PR}`,
      `pr:301:${CLASS_PR_REVIEW}`,
    ],
  );
  assert.equal(decisions[0].issue.number, 10, 'decision は根拠オブジェクトを保持する');
});

test('classifyAll: openBlockerRefs (集合外 open 参照) keep an issue in WAIT_DEP', () => {
  const snapshot = {
    issues: [issueState({ number: 20, blockedBy: [99] })],
    prs: [],
    openBlockerRefs: [99],
  };
  assert.equal(classifyAll(snapshot)[0].class, WAIT_DEP);
});

test('classifyAll: extras.explainedIssueNumbers が EXPLAIN の再発火を抑止する', () => {
  const snapshot = {
    issues: [issueState({ number: 20, labels: ['task-request', 'needs-review'] })],
    prs: [],
    openBlockerRefs: [],
  };
  assert.equal(classifyAll(snapshot)[0].class, CLASS_EXPLAIN, '教材 evidence なし → EXPLAIN');
  assert.equal(
    classifyAll(snapshot, {}, { explainedIssueNumbers: new Set([20]) })[0].class,
    WAIT_APPROVAL,
    'explains/ 正本 evidence → 教材あり扱い',
  );
});

test('classifyAll: running sets route issues and PRs to WAIT_RUNNING', () => {
  const snapshot = {
    issues: [issueState({ number: 20 })],
    prs: [prState({ number: 300 })],
    openBlockerRefs: [],
  };
  const decisions = classifyAll(snapshot, { issues: new Set([20]), prs: new Set([300]) });
  assert.deepEqual(decisions.map((d) => d.class), [WAIT_RUNNING, WAIT_RUNNING]);
});

// --- isDispatchClass / formatDecision ---

test('isDispatchClass: exactly the four dispatch classes', () => {
  for (const cls of [CLASS_PLAN, CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PR_REVIEW]) {
    assert.equal(isDispatchClass(cls), true, cls);
  }
  for (const cls of [WAIT_APPROVAL, WAIT_DEP, WAIT_ESCALATION, WAIT_PR, WAIT_RUNNING, SKIP_NON_TASK, SKIP_DRAFT]) {
    assert.equal(isDispatchClass(cls), false, cls);
  }
});

test('formatDecision: renders issue and PR targets', () => {
  assert.equal(
    formatDecision({ kind: 'issue', number: 9, class: CLASS_PLAN, reason: 'r' }),
    'PLAN #9 — r',
  );
  assert.equal(
    formatDecision({ kind: 'pr', number: 9, class: CLASS_PR_REVIEW }),
    'PR_REVIEW PR #9',
  );
});

// --- planBoardProjection（#201 分解 10 — 名前解決 id・非致命） ---

const STATUS_FIELD = {
  fieldId: 'F1',
  options: { Backlog: 'opt-backlog', Approval: 'opt-approval', Ready: 'opt-ready', Escalated: 'opt-escalated' },
};

function decisionOf(cls, issueOverrides = {}) {
  const issue = issueState(issueOverrides);
  return { kind: 'issue', number: issue.number, class: cls, issue };
}

test('planBoardProjection: WAIT_ESCALATION → Escalated 列（名前解決した option id）', () => {
  const { mutations, warnings } = planBoardProjection(
    [decisionOf(WAIT_ESCALATION, { number: 50, statusName: 'In progress' })],
    STATUS_FIELD,
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(mutations, [{
    number: 50, itemId: 'ITEM_100', fromName: 'In progress', toName: STATUS_ESCALATED, optionId: 'opt-escalated',
  }]);
});

test('planBoardProjection: WAIT_APPROVAL → Approval 列; 既に一致していれば no-op', () => {
  const { mutations } = planBoardProjection([
    decisionOf(WAIT_APPROVAL, { number: 51, statusName: 'Backlog' }),
    decisionOf(WAIT_APPROVAL, { number: 52, statusName: STATUS_APPROVAL }),
  ], STATUS_FIELD);
  assert.deepEqual(mutations.map((m) => [m.number, m.toName, m.optionId]), [[51, STATUS_APPROVAL, 'opt-approval']]);
});

test('planBoardProjection: Escalated からの掃き出しはしない（旧 .escalation.md 経路の移行窓を守る）', () => {
  const { mutations } = planBoardProjection([
    decisionOf(CLASS_IMPLEMENT, { number: 53, statusName: STATUS_ESCALATED }),
    decisionOf(CLASS_EXPLAIN, { number: 54, statusName: STATUS_ESCALATED }),
  ], STATUS_FIELD);
  assert.deepEqual(mutations, [], '列へ入れる投影のみ — label 未付与の裁定待ち signal を消さない');
});

test('planBoardProjection: 盤面外 issue・未知の列・PR・非 task は warning/skip（非致命）', () => {
  const offBoard = decisionOf(WAIT_APPROVAL, { number: 55, projectItemId: null });
  const nonTask = decisionOf(SKIP_NON_TASK, { number: 56, statusName: STATUS_ESCALATED });
  const pr = { kind: 'pr', number: 300, class: CLASS_PR_REVIEW, pr: {} };
  const noColumn = planBoardProjection(
    [decisionOf(WAIT_APPROVAL, { number: 57 })],
    { fieldId: 'F1', options: { Backlog: 'opt-backlog' } }, // Approval 列が無い盤面
  );
  const { mutations, warnings } = planBoardProjection([offBoard, nonTask, pr], STATUS_FIELD);
  assert.deepEqual(mutations, []);
  assert.equal(warnings.length, 1, '盤面外の task issue だけが warning（非 task と PR は対象外）');
  assert.deepEqual(noColumn.mutations, []);
  assert.equal(noColumn.warnings.length, 1);
});

test('planBoardProjection: Status field 未解決なら全 skip（fail-closed・非致命）', () => {
  const { mutations, warnings } = planBoardProjection([decisionOf(WAIT_ESCALATION)], null);
  assert.deepEqual(mutations, []);
  assert.equal(warnings.length, 1);
});
