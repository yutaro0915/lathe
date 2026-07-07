// Tests for the task-loop core (#116, ADR 0030 §2-3): verdict parsing,
// run-type selection, transitions, CLI args, blocked-by, landing pure
// functions. Manifest/resume tests live in inner-loop-manifest.test.mjs;
// plan-task tests in inner-loop-plan-task.test.mjs; prompt tests in
// inner-loop-prompts.test.mjs; side-effect/CLI tests in
// inner-loop-driver.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  VALID_VERDICT_TOKENS,
  selectRunType,
  nextState,
  nextPlanTaskState,
  TASK_LOOP_STAGES,
  TASK_LOOP_TERMINAL,
  PLAN_TASK_STAGES,
  PLAN_TASK_TERMINAL,
  parseDriverArgs,
  parseBlockedBy,
  issueLabelNames,
  issueHasLabel,
  tailLines,
  stageRequiresFreshMainRebase,
  runStageWithUnparsableRetry,
  extractFirstCommitMessage,
  splitCommitMessage,
  buildPrBodyWithCloses,
  buildPrCreateArgs,
  buildPrMergeArgs,
} from './inner-loop.mjs';
import { selectBackend, resolveResumeBackend, detectHollowImplement } from './inner-loop-backends.mjs';

// --- parseVerdict ---

test('parseVerdict: all valid tokens parse correctly', () => {
  for (const token of VALID_VERDICT_TOKENS) {
    assert.equal(parseVerdict(`work done\nVERDICT: ${token}`), token);
  }
});

test('parseVerdict: valid token set is the shrunk loop set (#116)', () => {
  assert.deepEqual(VALID_VERDICT_TOKENS, ['PLAN_READY', 'ASK_PDM', 'IMPL_DONE', 'ESCALATE']);
});

test('parseVerdict: removed stage tokens (PASS/CHANGES/GREEN/RED/KNOWN/NOVEL) are no longer accepted', () => {
  for (const token of ['PASS', 'CHANGES', 'GREEN', 'RED', 'KNOWN', 'NOVEL']) {
    assert.equal(parseVerdict(`done\nVERDICT: ${token}`), null);
  }
});

test('parseVerdict: missing VERDICT line → null', () => {
  assert.equal(parseVerdict('all done, no verdict here'), null);
});

test('parseVerdict: empty/null/undefined input → null', () => {
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(undefined), null);
});

test('parseVerdict: multiple VERDICT lines → last one wins', () => {
  assert.equal(parseVerdict('VERDICT: ESCALATE\nmore work\nVERDICT: IMPL_DONE'), 'IMPL_DONE');
});

test('parseVerdict: VERDICT embedded mid-text still parses (last match)', () => {
  assert.equal(parseVerdict('quote: "VERDICT: ESCALATE" was earlier\nVERDICT: IMPL_DONE\ntrailing'), 'IMPL_DONE');
});

// --- selectRunType (ADR 0030 追記 A: label だけを見る) ---

test('selectRunType: needs-plan label selects plan-task', () => {
  assert.equal(selectRunType(['task-request', 'needs-plan']), 'plan-task');
});

test('selectRunType: label match is case-insensitive', () => {
  assert.equal(selectRunType(['Needs-Plan']), 'plan-task');
});

test('selectRunType: no needs-plan label selects the implementation task loop', () => {
  assert.equal(selectRunType(['task-request']), 'task');
  assert.equal(selectRunType([]), 'task');
  assert.equal(selectRunType(undefined), 'task');
});

// --- nextState (task loop: IMPLEMENT → LAND のみ, ADR 0030 §3) ---

test('task loop stage table: IMPLEMENT only, terminal LAND', () => {
  assert.deepEqual(TASK_LOOP_STAGES, ['IMPLEMENT']);
  assert.equal(TASK_LOOP_TERMINAL, 'LAND');
});

test('nextState: IMPLEMENT + IMPL_DONE -> LAND', () => {
  assert.deepEqual(nextState('IMPLEMENT', 'IMPL_DONE'), { next: 'LAND' });
});

test('nextState: IMPLEMENT + ESCALATE -> ESCALATE', () => {
  assert.deepEqual(nextState('IMPLEMENT', 'ESCALATE'), { next: 'ESCALATE' });
});

test('nextState: null verdict (unparsable) -> ESCALATE', () => {
  assert.deepEqual(nextState('IMPLEMENT', null), { next: 'ESCALATE' });
});

test('nextState: removed stages (PLAN/REVIEW/VERIFY/TRIAGE) are unknown -> ESCALATE', () => {
  for (const removed of ['PLAN', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']) {
    assert.deepEqual(nextState(removed, 'IMPL_DONE'), { next: 'ESCALATE' });
  }
});

// --- nextPlanTaskState (plan-task: PLAN → FILE_CHILDREN | ASK_PDM) ---

test('plan-task stage table: PLAN only, terminal FILE_CHILDREN', () => {
  assert.deepEqual(PLAN_TASK_STAGES, ['PLAN']);
  assert.equal(PLAN_TASK_TERMINAL, 'FILE_CHILDREN');
});

test('nextPlanTaskState: PLAN + PLAN_READY -> FILE_CHILDREN', () => {
  assert.deepEqual(nextPlanTaskState('PLAN', 'PLAN_READY'), { next: 'FILE_CHILDREN' });
});

test('nextPlanTaskState: PLAN + ASK_PDM -> ASK_PDM (正常終端, ADR 0030 追記 E)', () => {
  assert.deepEqual(nextPlanTaskState('PLAN', 'ASK_PDM'), { next: 'ASK_PDM' });
});

test('nextPlanTaskState: PLAN + ESCALATE -> ESCALATE', () => {
  assert.deepEqual(nextPlanTaskState('PLAN', 'ESCALATE'), { next: 'ESCALATE' });
});

test('nextPlanTaskState: null verdict -> ESCALATE', () => {
  assert.deepEqual(nextPlanTaskState('PLAN', null), { next: 'ESCALATE' });
});

test('nextPlanTaskState: unknown state -> ESCALATE', () => {
  assert.deepEqual(nextPlanTaskState('RESEARCH', 'PLAN_READY'), { next: 'ESCALATE' });
});

// --- parseDriverArgs (issue = task, ADR 0031) ---

test('parseDriverArgs: parses positional issue number with flags', () => {
  const parsed = parseDriverArgs(['77', '--dry-run', '--backend', 'codex', '--backend-implement', 'claude']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.issueNumber, 77);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.resume, false);
  assert.equal(parsed.backendFlags.global, 'codex');
  assert.equal(parsed.backendFlags.stages.IMPLEMENT, 'claude');
});

test('parseDriverArgs: --resume flag', () => {
  const parsed = parseDriverArgs(['12', '--resume']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.resume, true);
});

test('parseDriverArgs: missing issue number is an error', () => {
  assert.match(parseDriverArgs([]).error, /missing or invalid issue number/);
  assert.match(parseDriverArgs(['--dry-run']).error, /missing or invalid issue number/);
});

test('parseDriverArgs: non-numeric issue is an error', () => {
  assert.match(parseDriverArgs(['abc']).error, /missing or invalid issue number/);
});

test('parseDriverArgs: removed --plan and --task flags are rejected (single issue-number CLI)', () => {
  assert.match(parseDriverArgs(['--plan', '9']).error, /unknown argument: --plan/);
  assert.match(parseDriverArgs(['--task', 'TASK-9']).error, /unknown argument: --task/);
});

test('parseDriverArgs: bare TASK-<n> positional is rejected (issue numbers only)', () => {
  assert.match(parseDriverArgs(['TASK-9']).error, /missing or invalid issue number/);
});

test('parseDriverArgs: second positional is an error', () => {
  assert.match(parseDriverArgs(['9', '10']).error, /unexpected positional argument: 10/);
});

// --- parseBlockedBy (ADR 0031 §2) ---

test('parseBlockedBy: single ref', () => {
  assert.deepEqual(parseBlockedBy('blocked-by #12'), [12]);
});

test('parseBlockedBy: optional colon and multiple refs per mention', () => {
  assert.deepEqual(parseBlockedBy('blocked-by: #12, #13'), [12, 13]);
});

test('parseBlockedBy: multiple mentions are collected and de-duped in order', () => {
  const body = 'intro\nblocked-by #5\nmore text blocked-by #7, #5\n';
  assert.deepEqual(parseBlockedBy(body), [5, 7]);
});

test('parseBlockedBy: case-insensitive', () => {
  assert.deepEqual(parseBlockedBy('Blocked-By #3'), [3]);
});

test('parseBlockedBy: no refs / empty / null → []', () => {
  assert.deepEqual(parseBlockedBy('no deps here'), []);
  assert.deepEqual(parseBlockedBy(''), []);
  assert.deepEqual(parseBlockedBy(null), []);
});

test('parseBlockedBy: a bare #N without the blocked-by keyword is not a dependency', () => {
  assert.deepEqual(parseBlockedBy('relates to #42'), []);
});

// --- issue label helpers ---

test('issueLabelNames: extracts names from gh label objects and strings', () => {
  assert.deepEqual(issueLabelNames({ labels: [{ name: 'task-request' }, 'needs-plan', { name: '' }] }), ['task-request', 'needs-plan']);
  assert.deepEqual(issueLabelNames({}), []);
});

test('issueHasLabel: case-insensitive membership', () => {
  const issue = { labels: [{ name: 'Task-Request' }] };
  assert.equal(issueHasLabel(issue, 'task-request'), true);
  assert.equal(issueHasLabel(issue, 'needs-plan'), false);
});

// --- tailLines ---

test('tailLines: returns last n lines (default 30)', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
  const result = tailLines(text);
  assert.equal(result.split('\n').length, 30);
  assert.ok(result.startsWith('line-11'));
  assert.ok(result.endsWith('line-40'));
});

test('tailLines: shorter input returned unchanged (trimmed), custom n, nullish', () => {
  assert.equal(tailLines('  a\nb  '), 'a\nb');
  assert.equal(tailLines('a\nb\nc', 2), 'b\nc');
  assert.equal(tailLines(null), '');
  assert.equal(tailLines(undefined), '');
});

// --- stageRequiresFreshMainRebase ---

test('stageRequiresFreshMainRebase: only IMPLEMENT rebases before spawning', () => {
  assert.equal(stageRequiresFreshMainRebase('IMPLEMENT'), true);
  assert.equal(stageRequiresFreshMainRebase('PLAN'), false);
  assert.equal(stageRequiresFreshMainRebase('LAND'), false);
});

// --- runStageWithUnparsableRetry ---

test('runStageWithUnparsableRetry: records UNPARSABLE then returns successful retry verdict', () => {
  const results = ['no verdict here', 'done\nVERDICT: IMPL_DONE'];
  let calls = 0;
  const recorded = [];
  const result = runStageWithUnparsableRetry({
    runAttempt: () => ({ envelope: { result: results[calls++] } }),
    recordAttempt: ({ manifestVerdict, unparsableRetries }) => recorded.push({ manifestVerdict, unparsableRetries }),
  });
  assert.equal(calls, 2);
  assert.equal(result.verdict, 'IMPL_DONE');
  assert.deepEqual(recorded, [
    { manifestVerdict: 'UNPARSABLE', unparsableRetries: 0 },
    { manifestVerdict: 'IMPL_DONE', unparsableRetries: 1 },
  ]);
});

test('runStageWithUnparsableRetry: stops after one unparsable retry', () => {
  let calls = 0;
  const recorded = [];
  const result = runStageWithUnparsableRetry({
    runAttempt: () => { calls += 1; return { envelope: { result: 'still no verdict' } }; },
    recordAttempt: ({ manifestVerdict }) => recorded.push(manifestVerdict),
  });
  assert.equal(calls, 2);
  assert.equal(result.verdict, null);
  assert.equal(result.manifestVerdict, 'UNPARSABLE');
  assert.deepEqual(recorded, ['UNPARSABLE', 'UNPARSABLE']);
});

test('runStageWithUnparsableRetry: does not retry regular verdicts', () => {
  let calls = 0;
  const result = runStageWithUnparsableRetry({
    runAttempt: () => { calls += 1; return { envelope: { result: 'VERDICT: ESCALATE' } }; },
    recordAttempt: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.verdict, 'ESCALATE');
});

// --- landing pure functions ---

test('extractFirstCommitMessage: first NUL-separated record wins', () => {
  assert.equal(extractFirstCommitMessage('feat: one\n\nbody\0fix: two\0'), 'feat: one\n\nbody');
  assert.equal(extractFirstCommitMessage('only: subject\0'), 'only: subject');
});

test('splitCommitMessage: subject + body / subject only / empty', () => {
  assert.deepEqual(splitCommitMessage('subj\n\nbody line'), { subject: 'subj', body: 'body line' });
  assert.deepEqual(splitCommitMessage('subj only'), { subject: 'subj only', body: 'subj only' });
  assert.deepEqual(splitCommitMessage(''), { subject: '', body: '' });
});

test('buildPrBodyWithCloses: appends Closes #N to the body (監査役裁定 4)', () => {
  assert.equal(buildPrBodyWithCloses('body text', 116), 'body text\n\nCloses #116');
});

test('buildPrBodyWithCloses: empty body becomes just the Closes line', () => {
  assert.equal(buildPrBodyWithCloses('', 9), 'Closes #9');
  assert.equal(buildPrBodyWithCloses(null, 9), 'Closes #9');
});

test('buildPrBodyWithCloses: does not duplicate an existing Closes ref (case-insensitive)', () => {
  assert.equal(buildPrBodyWithCloses('fixes stuff\n\ncloses #9', 9), 'fixes stuff\n\ncloses #9');
});

test('buildPrBodyWithCloses: a different issue ref does not suppress the append', () => {
  assert.equal(buildPrBodyWithCloses('Closes #8', 9), 'Closes #8\n\nCloses #9');
});

test('buildPrCreateArgs: returns correct gh argv, multi-line body preserved', () => {
  const args = buildPrCreateArgs({ base: 'main', head: 'inner/issue-9', title: 't', body: 'a\n\nb' });
  assert.deepEqual(args, ['pr', 'create', '--base', 'main', '--head', 'inner/issue-9', '--title', 't', '--body', 'a\n\nb']);
});

test('buildPrMergeArgs: auto + squash, no --delete-branch (driver owns local cleanup)', () => {
  const args = buildPrMergeArgs({ branch: 'inner/issue-9' });
  assert.deepEqual(args, ['pr', 'merge', 'inner/issue-9', '--auto', '--squash']);
  assert.ok(!args.includes('--delete-branch'));
});

// --- backends helpers still re-exported/consumed by the driver ---

test('selectBackend: stage override > global > fallback', () => {
  assert.equal(selectBackend('IMPLEMENT', { global: null, stages: {} }), 'claude');
  assert.equal(selectBackend('IMPLEMENT', { global: 'codex', stages: {} }), 'codex');
  assert.equal(selectBackend('IMPLEMENT', { global: 'codex', stages: { IMPLEMENT: 'claude' } }), 'claude');
  assert.equal(selectBackend('IMPLEMENT', { global: null, stages: {} }, 'codex'), 'codex');
});

test('resolveResumeBackend: most-recent non-null backend, else null', () => {
  assert.equal(resolveResumeBackend([{ backend: 'claude' }, { backend: null }, { backend: 'codex' }]), 'codex');
  assert.equal(resolveResumeBackend([{ backend: null }, {}]), null);
});

test('detectHollowImplement: IMPL_DONE with base===head is hollow', () => {
  assert.equal(detectHollowImplement({ verdict: 'IMPL_DONE', baseSha: 'a', headSha: 'a' }), true);
  assert.equal(detectHollowImplement({ verdict: 'IMPL_DONE', baseSha: 'a', headSha: 'b' }), false);
  assert.equal(detectHollowImplement({ verdict: 'ESCALATE', baseSha: 'a', headSha: 'a' }), false);
  assert.equal(detectHollowImplement({ verdict: 'IMPL_DONE', baseSha: null, headSha: 'a' }), false);
});
