// Tests for the plan-task run type's pure plumbing (#116, ADR 0030 §2):
// child block parsing, plan-local dependency resolution, child issue body,
// gh issue create wiring, and terminal comment builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIVER_CONFIG } from './inner-loop-config.mjs';
import {
  parseBlockedByLine,
  parsePlanChildBlocks,
  validatePlanChildBlocks,
  buildPlanValidationFeedback,
  decidePlanValidationAction,
  resolvePlanChildDependency,
  buildChildIssueBody,
  parseCreatedIssueNumber,
  createChildIssues,
  buildPlanTaskCloseComment,
  buildAskPdmComment,
  splitCommentBody,
  COMMENT_BODY_MAX,
  runPlanTask,
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

// --- validatePlanChildBlocks（#201 Wave4: FILE_CHILDREN 前の書式検証。表駆動） ---

function childBlock({ title = 'feat: child', blockedBy = 'none', touches = 'scripts/a.mjs', body = '## 問題\n本文。' } = {}) {
  return [`Title: ${title}`, `Blocked-by: ${blockedBy}`, `Touches: ${touches}`, '', body].join('\n');
}

const VALIDATE_CASES = [
  { name: 'valid single block -> ok', planText: childBlock(), ok: true },
  { name: 'valid multi block with backward plan#k -> ok', planText: [childBlock(), childBlock({ blockedBy: 'plan#1, #42' })].join('\n\n'), ok: true },
  { name: 'no Title line at all（実測 2: missing "Title:"）', planText: 'just prose\nVERDICT: PLAN_READY', findings: [/missing required "Title:" line/] },
  { name: 'missing Blocked-by line', planText: 'Title: t\nTouches: a\nbody', findings: [/plan block 1: .*missing required "Blocked-by:" line/] },
  { name: 'empty Blocked-by value', planText: 'Title: t\nBlocked-by:\nTouches: a', findings: [/plan block 1: .*empty "Blocked-by:" value/] },
  { name: 'missing Touches line', planText: 'Title: t\nBlocked-by: none\nbody', findings: [/plan block 1 is missing required "Touches:" line/] },
  { name: 'forward reference（実測 1 の類: 前方参照 plan#k）', planText: [childBlock({ blockedBy: 'plan#2' }), childBlock()].join('\n\n'), findings: [/plan block 1: "plan#2" is a forward reference/] },
  { name: 'self reference', planText: [childBlock(), childBlock({ blockedBy: 'plan#2' })].join('\n\n'), findings: [/plan block 2: "plan#2" is a self reference/] },
  { name: '欠番（実測 1: 解決できない plan#5）', planText: [childBlock(), childBlock({ blockedBy: 'plan#5' })].join('\n\n'), findings: [/plan block 2: "plan#5" references a non-existent plan block \(this plan has plan#1\.\.plan#2\)/] },
  { name: 'duplicate plan#k reference', planText: [childBlock(), childBlock({ blockedBy: 'plan#1, plan#1' })].join('\n\n'), findings: [/plan block 2: duplicate reference "plan#1"/] },
  {
    name: 'multiple findings accumulate（fail-fast しない — 1 周で全指摘を差し戻す）',
    planText: ['Title: a', 'Blocked-by: plan#3', 'Touches: x', '', 'Title: b', 'Blocked-by: none', 'body-without-touches'].join('\n'),
    findings: [/plan block 1: "plan#3" references a non-existent plan block/, /plan block 2 is missing required "Touches:" line/],
  },
];

for (const c of VALIDATE_CASES) {
  test(`validatePlanChildBlocks: ${c.name}`, () => {
    const result = validatePlanChildBlocks(c.planText);
    if (c.ok) {
      assert.equal(result.ok, true, JSON.stringify(result.findings));
      assert.deepEqual(result.findings, []);
      assert.ok(result.children.length >= 1);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.findings.length, c.findings.length, JSON.stringify(result.findings));
      c.findings.forEach((pattern, i) => assert.match(result.findings[i], pattern));
    }
  });
}

test('parsePlanChildBlocks: 前方参照 plan#k は parse でも fail（validate と同一契約・validated ⇒ 投函可能）', () => {
  const result = parsePlanChildBlocks([childBlock({ blockedBy: 'plan#2' }), childBlock()].join('\n\n'));
  assert.equal(result.ok, false);
  assert.match(result.error, /forward reference/);
});

// --- buildPlanValidationFeedback / decidePlanValidationAction ---

test('buildPlanValidationFeedback: 指摘を箇条書きで列挙し出力契約を再掲する', () => {
  const feedback = buildPlanValidationFeedback(['plan block 1: x', 'plan block 2: y']);
  assert.ok(feedback.includes('- plan block 1: x'));
  assert.ok(feedback.includes('- plan block 2: y'));
  assert.ok(feedback.includes('後方参照のみ'));
});

test('decidePlanValidationAction: ok -> file（周回数に依らない）', () => {
  assert.deepEqual(decidePlanValidationAction({ validation: { ok: true }, retriesUsed: 0 }), { action: 'file' });
  assert.deepEqual(decidePlanValidationAction({ validation: { ok: true }, retriesUsed: 5 }), { action: 'file' });
});

test('decidePlanValidationAction: NG かつ周回残あり -> retry（上限 1）', () => {
  assert.equal(DRIVER_CONFIG.maxPlanChildrenValidationRetries, 1);
  assert.deepEqual(decidePlanValidationAction({ validation: { ok: false, findings: ['x'] }, retriesUsed: 0 }), { action: 'retry' });
});

test('decidePlanValidationAction: NG かつ上限到達 -> escalate', () => {
  const result = decidePlanValidationAction({ validation: { ok: false, findings: ['x'] }, retriesUsed: DRIVER_CONFIG.maxPlanChildrenValidationRetries });
  assert.equal(result.action, 'escalate');
  assert.match(result.reason, /修正周回上限超過/);
});

test('decidePlanValidationAction: maxRetries is overridable', () => {
  assert.equal(decidePlanValidationAction({ validation: { ok: false }, retriesUsed: 0, maxRetries: 0 }).action, 'escalate');
  assert.equal(decidePlanValidationAction({ validation: { ok: false }, retriesUsed: 1, maxRetries: 2 }).action, 'retry');
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

test('buildAskPdmComment: plan 全文（Title: block を含む）が comment 本文に含まれる', () => {
  const resultText = [
    'Title: feat: child',
    'Blocked-by: none',
    'Touches: scripts/a.mjs',
    '',
    '本文。',
    '',
    '選択肢 A: foo / 選択肢 B: bar。推奨 A。',
    'VERDICT: ASK_PDM',
  ].join('\n');
  const comment = buildAskPdmComment({ resultText });
  assert.ok(comment.includes('Title: feat: child'), 'Title: block が comment に含まれること');
  assert.ok(comment.includes('Blocked-by: none'));
  assert.ok(comment.includes('Touches: scripts/a.mjs'));
  assert.ok(comment.includes('選択肢 A: foo / 選択肢 B: bar'));
  assert.ok(!comment.includes('VERDICT:'));
});

// --- splitCommentBody（AC3: 65k 分割境界 unit） ---

test('splitCommentBody: body ≤ maxLen -> 1 要素の配列（分割なし）', () => {
  assert.deepEqual(splitCommentBody('short body', 100), ['short body']);
  // デフォルト maxLen = COMMENT_BODY_MAX (65536)
  assert.equal(COMMENT_BODY_MAX, 65536);
  assert.equal(splitCommentBody('x'.repeat(COMMENT_BODY_MAX)).length, 1);
});

test('splitCommentBody: body > maxLen かつ改行あり -> 改行境界で分割する', () => {
  // 'line1\nline2' = 11 chars, maxLen=12 → splits before 'line3'
  const chunks = splitCommentBody('line1\nline2\nline3', 12);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'line1\nline2');
  assert.equal(chunks[1], 'line3');
});

test('splitCommentBody: body > maxLen かつ改行なし -> maxLen でハード分割する', () => {
  const body = 'a'.repeat(150);
  const chunks = splitCommentBody(body, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks[1].length, 50);
  assert.equal(chunks.join(''), body); // データロスなし
});

// --- runPlanTask（#201 Wave4: 書式検証の修正周回。全副作用を fake deps で注入） ---

const BACKEND_FLAGS = { global: null, stages: {} };

function makePlanTaskDeps({ stageResults, createdNumbers = [901] }) {
  const stageCalls = [];
  const recorded = [];
  const escalations = [];
  let created = 0;
  const runStage = (stage, prompt, cwd, resumeSessionId, backend) => {
    const result = stageResults[Math.min(stageCalls.length, stageResults.length - 1)];
    stageCalls.push({ stage, prompt, cwd, backend });
    return { session_id: `plan-${stageCalls.length}`, result, total_cost_usd: 0.1, backend: 'claude' };
  };
  const spawn = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      const n = createdNumbers[created++];
      return { status: 0, stdout: `https://github.com/yutaro0915/lathe/issues/${n}\n`, stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return {
    deps: {
      runStage,
      spawnSync: spawn,
      log: () => {},
      recordManifestEntry: (entry) => recorded.push(entry),
      escalate: (issueNumber, stage, verdict, excerpt) => escalations.push({ issueNumber, stage, verdict, excerpt }),
      die: (msg) => { throw new Error(`die: ${msg}`); },
    },
    stageCalls, recorded, escalations,
  };
}

const BAD_PLAN = ['Title: only child', 'Blocked-by: plan#5', 'Touches: scripts/a.mjs', '', 'body', 'VERDICT: PLAN_READY'].join('\n');
const GOOD_PLAN = ['Title: only child', 'Blocked-by: none', 'Touches: scripts/a.mjs', '', 'body', 'VERDICT: PLAN_READY'].join('\n');

test('runPlanTask: 書式検証 NG は escalate せず所見を注入して PLAN へ 1 周差し戻し、修正後に投函する', () => {
  const { deps, stageCalls, recorded, escalations } = makePlanTaskDeps({ stageResults: [BAD_PLAN, GOOD_PLAN] });
  const exitCode = runPlanTask(200, { title: 't', body: 'b', comments: [] }, BACKEND_FLAGS, deps);
  assert.equal(exitCode, 0);
  assert.equal(stageCalls.length, 2);
  // 1 周目の prompt に所見は無く、差し戻し周回の prompt にだけ所見が注入される
  assert.ok(!stageCalls[0].prompt.includes('前回 review 所見'));
  assert.ok(stageCalls[1].prompt.includes('前回 review 所見（FILE_CHILDREN 書式検証 NG）'));
  assert.ok(stageCalls[1].prompt.includes('plan#5'));
  assert.equal(escalations.length, 0);
  // manifest: 検証 RED → 修正後の FILE_CHILDREN / CLOSE_SOURCE PASS
  assert.ok(recorded.some((entry) => entry.stage === 'FILE_CHILDREN' && entry.verdict === 'RED'));
  assert.ok(recorded.some((entry) => entry.stage === 'FILE_CHILDREN' && entry.verdict === 'PASS'));
  assert.ok(recorded.some((entry) => entry.stage === 'CLOSE_SOURCE' && entry.verdict === 'PASS'));
});

test('runPlanTask: 再 NG は差し戻さず projectEscalation（上限 1・黙った推測補正はしない）', () => {
  const { deps, stageCalls, escalations } = makePlanTaskDeps({ stageResults: [BAD_PLAN, BAD_PLAN] });
  assert.throws(
    () => runPlanTask(200, { title: 't', body: 'b', comments: [] }, BACKEND_FLAGS, deps),
    /die: plan-task escalated/,
  );
  assert.equal(stageCalls.length, 2);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].stage, 'FILE_CHILDREN');
  assert.match(escalations[0].excerpt, /修正周回上限超過/);
  assert.match(escalations[0].excerpt, /plan#5/);
});

// --- runPlanTask: ASK_PDM 経路（plan 全文が issue comment に投稿される） ---

test('runPlanTask: ASK_PDM 経路で comment 本文に plan 全文（Title: block を含む）が投稿される', () => {
  const ASK_PDM_RESULT = [
    'Title: feat: child',
    'Blocked-by: none',
    'Touches: scripts/a.mjs',
    '',
    '本文。',
    '',
    '選択肢 A: foo / 選択肢 B: bar。推奨 A。',
    'VERDICT: ASK_PDM',
  ].join('\n');

  const spawnCalls = [];
  const spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, input: opts?.input });
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };

  const recorded = [];
  const deps = {
    runStage: (_stage, _prompt, _cwd, _resumeId, _backend) => ({
      session_id: 'ask-pdm-1',
      result: ASK_PDM_RESULT,
      total_cost_usd: 0.05,
      backend: 'claude',
    }),
    spawnSync: spawn,
    log: () => {},
    recordManifestEntry: (entry) => recorded.push(entry),
    escalate: () => {},
    die: (msg) => { throw new Error(`die: ${msg}`); },
  };

  const exitCode = runPlanTask(200, { title: 't', body: 'b', comments: [] }, BACKEND_FLAGS, deps);
  assert.equal(exitCode, 0);
  // gh issue comment が 1 回だけ呼ばれること
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].args[0], 'issue');
  assert.equal(spawnCalls[0].args[1], 'comment');
  // comment 本文に plan 全文（Title: block を含む）が入ること（issue = 成果物の正本、ADR 0031）
  assert.ok(spawnCalls[0].input.includes('Title: feat: child'), 'Title: block が comment に含まれること');
  assert.ok(spawnCalls[0].input.includes('Blocked-by: none'));
  assert.ok(spawnCalls[0].input.includes('選択肢 A: foo / 選択肢 B: bar'));
  // VERDICT 行はストリップされること
  assert.ok(!spawnCalls[0].input.includes('VERDICT:'), 'VERDICT 行はストリップされること');
  // manifest に ASK_PDM エントリが記録されること（AC4: result_text に全文が入ること）
  const askPdmEntry = recorded.find((e) => e.stage === 'ASK_PDM' && e.verdict === 'ASK_PDM');
  assert.ok(askPdmEntry, 'ASK_PDM manifest entry が存在すること');
  assert.ok(askPdmEntry.result_text.includes('Title: feat: child'), 'result_text に plan 全文（Title: block）が含まれること');
  assert.ok(askPdmEntry.result_text.includes('選択肢 A: foo / 選択肢 B: bar'), 'result_text に裁定要求が含まれること');
});

test('runPlanTask: ASK_PDM 経路 — 65k 超の本文は複数の gh issue comment 呼び出しに分割される', () => {
  const longBody = 'x'.repeat(COMMENT_BODY_MAX); // header を加えると必ず超える
  const ASK_PDM_LARGE = `Title: feat: child\nBlocked-by: none\nTouches: scripts/a.mjs\n\n${longBody}\n\nVERDICT: ASK_PDM`;
  const commentInputs = [];
  const deps = {
    runStage: () => ({ session_id: 'x', result: ASK_PDM_LARGE, total_cost_usd: 0, backend: 'claude' }),
    spawnSync: (cmd, args, opts) => {
      if (cmd === 'gh' && args[1] === 'comment') { commentInputs.push(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
      throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
    },
    log: () => {}, recordManifestEntry: () => {}, escalate: () => {},
    die: (msg) => { throw new Error(msg); },
  };
  assert.equal(runPlanTask(200, { title: 't', body: 'b', comments: [] }, BACKEND_FLAGS, deps), 0);
  assert.ok(commentInputs.length > 1, `gh issue comment が複数回呼ばれること（実際: ${commentInputs.length} 回）`);
  for (const chunk of commentInputs) {
    assert.ok(chunk.length <= COMMENT_BODY_MAX, `chunk が COMMENT_BODY_MAX 以下であること`);
  }
});
