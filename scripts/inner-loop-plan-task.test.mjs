// Tests for the plan-task run type's pure plumbing (#116, ADR 0030 §2):
// child block parsing, plan-local dependency resolution, child issue body,
// gh issue create wiring, and terminal comment builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlockedByLine,
  parsePlanChildBlocks,
  resolvePlanChildDependency,
  buildChildIssueBody,
  parseCreatedIssueNumber,
  createChildIssues,
  buildPlanTaskCloseComment,
  buildAskPdmComment,
} from './inner-loop-plan-task.mjs';
import { parseBlockedBy } from './inner-loop-core.mjs';

const PLAN_TEXT = [
  'Title: feat: first child',
  'Blocked-by: none',
  'Touches: scripts/inner-loop.mjs',
  '',
  '## 問題',
  'first の問題。',
  '',
  'Title: feat: second child',
  'Blocked-by: plan#1, #42',
  'Touches: apps/web/lib/',
  '',
  '## 問題',
  'second の問題。',
  '',
  'Rejected: third candidate — out of scope for this parent',
  'VERDICT: PLAN_READY',
].join('\n');

// --- parseBlockedByLine ---

test('parseBlockedByLine: missing line (null) -> fail', () => {
  const result = parseBlockedByLine(null);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing required "Blocked-by:" line/);
});

test('parseBlockedByLine: empty / whitespace-only value -> fail', () => {
  assert.equal(parseBlockedByLine('').ok, false);
  assert.equal(parseBlockedByLine('   ').ok, false);
});

test('parseBlockedByLine: explicit "none" (case-insensitive) -> ok with empty value', () => {
  assert.deepEqual(parseBlockedByLine('none'), { ok: true, blockedBy: '' });
  assert.deepEqual(parseBlockedByLine('NONE'), { ok: true, blockedBy: '' });
});

test('parseBlockedByLine: refs are preserved as written', () => {
  assert.deepEqual(parseBlockedByLine(' #12, plan#2 '), { ok: true, blockedBy: '#12, plan#2' });
});

// --- parsePlanChildBlocks ---

test('parsePlanChildBlocks: parses multiple blocks and rejected candidates', () => {
  const result = parsePlanChildBlocks(PLAN_TEXT);
  assert.equal(result.ok, true);
  assert.equal(result.children.length, 2);
  assert.deepEqual(result.rejected, [{ candidate: 'third candidate', reason: 'out of scope for this parent' }]);

  const [first, second] = result.children;
  assert.equal(first.index, 1);
  assert.equal(first.title, 'feat: first child');
  assert.equal(first.blockedBy, '');
  assert.equal(first.touches, 'scripts/inner-loop.mjs');
  assert.ok(first.plan.includes('first の問題。'));
  assert.ok(!first.plan.includes('VERDICT:'));

  assert.equal(second.index, 2);
  assert.equal(second.blockedBy, 'plan#1, #42');
  assert.equal(second.touches, 'apps/web/lib/');
});

test('parsePlanChildBlocks: no Title line at all -> fail', () => {
  const result = parsePlanChildBlocks('just prose\nVERDICT: PLAN_READY');
  assert.equal(result.ok, false);
  assert.match(result.error, /missing required "Title:" line/);
});

test('parsePlanChildBlocks: block missing Blocked-by -> fail with block index', () => {
  const result = parsePlanChildBlocks('Title: t\nTouches: a\nplan body');
  assert.equal(result.ok, false);
  assert.match(result.error, /plan block 1: .*"Blocked-by:"/);
});

test('parsePlanChildBlocks: block missing Touches -> fail with block index', () => {
  const result = parsePlanChildBlocks('Title: t\nBlocked-by: none\nplan body');
  assert.equal(result.ok, false);
  assert.match(result.error, /plan block 1 is missing required "Touches:" line/);
});

// --- resolvePlanChildDependency ---

test('resolvePlanChildDependency: replaces plan#k with created issue numbers', () => {
  const created = new Map([[1, 901]]);
  assert.deepEqual(resolvePlanChildDependency('plan#1, #42', created), { ok: true, blockedBy: '#901, #42' });
});

test('resolvePlanChildDependency: unresolved plan#k reference fails', () => {
  const result = resolvePlanChildDependency('plan#3', new Map());
  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved plan-local dependency reference\(s\): plan#3/);
});

// --- buildChildIssueBody ---

test('buildChildIssueBody: parent is always in the blocked-by line (親子間に張る)', () => {
  const body = buildChildIssueBody({ parentIssueNumber: 200, blockedBy: '#42', touches: 'scripts/', plan: 'plan body\nVERDICT: PLAN_READY' });
  assert.ok(body.startsWith('Generated from #200 (plan-task)'));
  assert.ok(body.includes('blocked-by #200, #42'));
  assert.ok(body.includes('Touches: scripts/'));
  assert.ok(body.includes('plan body'));
  assert.ok(!body.includes('VERDICT:'));
});

test('buildChildIssueBody: blocked-by line is machine-readable by parseBlockedBy (round-trip)', () => {
  const body = buildChildIssueBody({ parentIssueNumber: 200, blockedBy: '#901, #42', touches: '', plan: 'p' });
  assert.deepEqual(parseBlockedBy(body), [200, 901, 42]);
});

test('buildChildIssueBody: duplicate parent ref is not doubled', () => {
  const body = buildChildIssueBody({ parentIssueNumber: 200, blockedBy: '#200', touches: '', plan: 'p' });
  assert.deepEqual(parseBlockedBy(body), [200]);
});

// --- parseCreatedIssueNumber ---

test('parseCreatedIssueNumber: parses the issue URL from gh stdout', () => {
  assert.equal(parseCreatedIssueNumber('https://github.com/yutaro0915/lathe/issues/901\n'), 901);
  assert.equal(parseCreatedIssueNumber('no url here'), null);
  assert.equal(parseCreatedIssueNumber(null), null);
});

// --- createChildIssues (fake gh) ---

function fakeGhRun(createdNumbers) {
  const calls = [];
  let cursor = 0;
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, input: options?.input });
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      const n = createdNumbers[cursor++];
      return { status: 0, stdout: `https://github.com/yutaro0915/lathe/issues/${n}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` };
  };
  return { run, calls };
}

test('createChildIssues: files every block via gh issue create --label task-request and resolves plan#k', () => {
  const { run, calls } = fakeGhRun([901, 902]);
  const result = createChildIssues(200, PLAN_TEXT, { spawnSync: run });
  assert.equal(result.ok, true);
  assert.deepEqual(result.children.map((c) => c.issueNumber), [901, 902]);
  assert.equal(result.rejected.length, 1);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cmd, 'gh');
    assert.deepEqual(call.args.slice(0, 2), ['issue', 'create']);
    assert.ok(call.args.includes('--label'));
    assert.ok(call.args.includes('task-request'));
    assert.ok(call.args.includes('--body-file'));
  }
  // second child: plan#1 resolved to #901, parent #200 leads the refs
  assert.ok(calls[1].input.includes('blocked-by #200, #901, #42'));
});

test('createChildIssues: gh failure propagates the block index', () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'boom' });
  const result = createChildIssues(200, PLAN_TEXT, { spawnSync: run });
  assert.equal(result.ok, false);
  assert.match(result.error, /gh issue create failed for plan#1/);
});

test('createChildIssues: unparsable created-issue URL fails', () => {
  const run = () => ({ status: 0, stdout: 'created something', stderr: '' });
  const result = createChildIssues(200, PLAN_TEXT, { spawnSync: run });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not parse created issue number/);
});

test('createChildIssues: parse failure surfaces without any gh call', () => {
  const { run, calls } = fakeGhRun([]);
  const result = createChildIssues(200, 'prose only', { spawnSync: run });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

// --- terminal comment builders ---

test('buildPlanTaskCloseComment: lists children, rejected candidates, and the confirmed plan', () => {
  const comment = buildPlanTaskCloseComment({
    children: [
      { index: 1, issueNumber: 901, title: 'feat: first child' },
      { index: 2, issueNumber: 902, title: 'feat: second child' },
    ],
    rejected: [{ candidate: 'third', reason: 'why' }],
    planText: 'the plan\nVERDICT: PLAN_READY',
  });
  assert.ok(comment.includes('- plan#1 -> #901: feat: first child'));
  assert.ok(comment.includes('- plan#2 -> #902: feat: second child'));
  assert.ok(comment.includes('- third — why'));
  assert.ok(comment.includes('## confirmed plan'));
  assert.ok(comment.includes('the plan'));
  assert.ok(!comment.includes('VERDICT:'));
});

test('buildPlanTaskCloseComment: no rejected candidates renders "- none"', () => {
  const comment = buildPlanTaskCloseComment({ children: [], rejected: [], planText: 'p' });
  assert.ok(comment.includes('Rejected candidates:\n- none'));
});

test('buildAskPdmComment: marks the pause as a normal terminal and strips VERDICT lines', () => {
  const comment = buildAskPdmComment({ resultText: '選択肢 A / B。推奨 A。\nVERDICT: ASK_PDM' });
  assert.ok(comment.includes('正常終端'));
  assert.ok(comment.includes('選択肢 A / B。推奨 A。'));
  assert.ok(!comment.includes('VERDICT:'));
});
