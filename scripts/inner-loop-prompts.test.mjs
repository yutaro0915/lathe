// Tests for the shrunk stage prompts (#116): IMPLEMENT (issue body = plan,
// comments = 裁定) and plan-task PLAN (plan-format.md fail-closed injection,
// child block contract, ASK_PDM as a normal terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStagePrompt,
  buildImplementPrompt,
  buildPlanTaskPrompt,
  formatIssueComments,
  STAGE_PROMPT_BUILDERS,
} from './inner-loop-prompts.mjs';

const COMMENTS = [
  { author: { login: 'yutaro0915' }, createdAt: '2026-07-07T04:13:13Z', body: '監査役裁定: arm は PR 作成時。' },
  { author: { login: 'github-actions' }, createdAt: '2026-07-05T05:02:37Z', body: '登記完了。' },
];

// --- formatIssueComments ---

test('formatIssueComments: renders author, timestamp, and body per comment', () => {
  const block = formatIssueComments(COMMENTS);
  assert.ok(block.includes('### yutaro0915 — 2026-07-07T04:13:13Z'));
  assert.ok(block.includes('監査役裁定: arm は PR 作成時。'));
  assert.ok(block.includes('### github-actions — 2026-07-05T05:02:37Z'));
});

test('formatIssueComments: empty / missing comments -> empty string', () => {
  assert.equal(formatIssueComments([]), '');
  assert.equal(formatIssueComments(undefined), '');
});

// --- IMPLEMENT prompt ---

const IMPLEMENT_CTX = {
  issueNumber: 42,
  issueTitle: 'fix: the thing',
  issueBody: '## 問題\nthe plan lives here (body = plan)',
  comments: COMMENTS,
};

test('buildImplementPrompt: issue body is presented as the plan (ADR 0030 §2)', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('issue #42 / stage: IMPLEMENT'));
  assert.ok(prompt.includes('## issue（本文 = plan）'));
  assert.ok(prompt.includes('the plan lives here (body = plan)'));
});

test('buildImplementPrompt: comments (裁定・申し送り) are injected', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('裁定・申し送り'));
  assert.ok(prompt.includes('監査役裁定: arm は PR 作成時。'));
});

test('buildImplementPrompt: no comments -> no 裁定 section', () => {
  const prompt = buildImplementPrompt({ ...IMPLEMENT_CTX, comments: [] });
  assert.ok(!prompt.includes('裁定・申し送り'));
});

test('buildImplementPrompt: worktree role contract with issue naming', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('inner-issue-42'));
  assert.ok(prompt.includes('inner/issue-42'));
  assert.ok(prompt.includes('ネストした subagent を spawn しない'));
});

test('buildImplementPrompt: points to the implement skill and main-freshness contract', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('.claude/skills/implement/SKILL.md'));
  assert.ok(prompt.includes('git rebase main'));
});

test('buildImplementPrompt: premise break escalates without replanning (裁定 3: 暫定維持)', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('再計画せず ESCALATE'));
  assert.ok(prompt.includes('最小変更を発明せず ESCALATE'));
});

test('buildImplementPrompt: driver-owned mechanical checks are not assigned to the agent', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('driver が機械的に検知'));
  assert.ok(prompt.includes('repo の清浄度判定は agent の仕事ではありません'));
});

test('buildImplementPrompt: commit discipline (explicit git add, one commit)', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.includes('1 commit にまとめること'));
  assert.ok(prompt.includes('`git add -A` / `git add .` は禁止'));
});

test('buildImplementPrompt: verdict tokens are IMPL_DONE | ESCALATE only', () => {
  const prompt = buildImplementPrompt(IMPLEMENT_CTX);
  assert.ok(prompt.trimEnd().endsWith('<TOKEN> は次のいずれか: IMPL_DONE | ESCALATE'));
});

// --- plan-task PLAN prompt ---

const PLAN_FORMAT = '# Plan Format — 完全形の5セクション\n問題 / 選択肢 / 方針 / 契約 / 検証';
const PLAN_CTX = {
  issueNumber: 200,
  issueTitle: 'needs-plan: big topic',
  issueBody: 'split this into tasks',
  comments: [],
  planFormat: PLAN_FORMAT,
};

test('buildPlanTaskPrompt: injects the full plan-format.md text (#142 吸収)', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('issue #200 / stage: PLAN'));
  assert.ok(prompt.includes('design/plan-format.md'));
  assert.ok(prompt.includes('完全形の5セクション'));
});

test('buildPlanTaskPrompt: fail-closed — missing/empty planFormat throws', () => {
  assert.throws(() => buildPlanTaskPrompt({ ...PLAN_CTX, planFormat: undefined }), /fail-closed/);
  assert.throws(() => buildPlanTaskPrompt({ ...PLAN_CTX, planFormat: '   ' }), /fail-closed/);
});

test('buildPlanTaskPrompt: child block machine lines (Title / Blocked-by / Touches)', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('Title: <child issue title>'));
  assert.ok(prompt.includes('Blocked-by: #<n>, plan#<k>'));
  assert.ok(prompt.includes('"Blocked-by: none"'));
  assert.ok(prompt.includes('Touches: <path>, <path>'));
});

test('buildPlanTaskPrompt: candidates must be filed or rejected (silent drop 禁止)', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('silent drop 禁止'));
  assert.ok(prompt.includes('Rejected: <candidate> — <reason>'));
});

test('buildPlanTaskPrompt: granularity rule from ADR 0030 §5 is stated', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('人間が数分（理想 1 分）で完全に理解できる範囲'));
});

test('buildPlanTaskPrompt: external-space edits route to ASK_PDM, not child plans', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('`rubrics/`'));
  assert.ok(prompt.includes('`.claude/skills/`'));
  assert.ok(prompt.includes('VERDICT: ASK_PDM で終えてください（監査役の管轄です）'));
});

test('buildPlanTaskPrompt: ASK_PDM is described as a normal terminal (ADR 0030 追記 E)', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('escalation ではなく正常終端'));
});

test('buildPlanTaskPrompt: verdict tokens are PLAN_READY | ASK_PDM | ESCALATE', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.trimEnd().endsWith('<TOKEN> は次のいずれか: PLAN_READY | ASK_PDM | ESCALATE'));
});

test('buildPlanTaskPrompt: comments are injected when present', () => {
  const prompt = buildPlanTaskPrompt({ ...PLAN_CTX, comments: COMMENTS });
  assert.ok(prompt.includes('裁定・申し送り'));
  assert.ok(prompt.includes('監査役裁定: arm は PR 作成時。'));
});

// --- dispatch ---

test('buildStagePrompt: PLAN, TASK_PLAN, PLAN_REVIEW, and IMPLEMENT builders exist', () => {
  assert.deepEqual(Object.keys(STAGE_PROMPT_BUILDERS).sort(), ['IMPLEMENT', 'PLAN', 'PLAN_REVIEW', 'TASK_PLAN']);
});

test('buildStagePrompt: dispatch matches direct builder output', () => {
  assert.equal(buildStagePrompt('IMPLEMENT', IMPLEMENT_CTX), buildImplementPrompt(IMPLEMENT_CTX));
  assert.equal(buildStagePrompt('PLAN', PLAN_CTX), buildPlanTaskPrompt(PLAN_CTX));
});

test('buildStagePrompt: removed stages throw (REVIEW/VERIFY/TRIAGE/RESEARCH/NOPE)', () => {
  for (const stage of ['REVIEW', 'VERIFY', 'TRIAGE', 'RESEARCH', 'NOPE']) {
    assert.throws(() => buildStagePrompt(stage, {}), new RegExp(`unknown stage "${stage}"`));
  }
});
