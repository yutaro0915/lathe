// Tests for the shrunk stage prompts (#116): IMPLEMENT (issue body = plan,
// comments = 裁定) and plan-task PLAN (plan-format.md fail-closed injection,
// child block contract, ASK_PDM as a normal terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStagePrompt,
  buildImplementPrompt,
  buildLandReworkPrompt,
  buildPlanTaskPrompt,
  buildTaskLoopPlanPrompt,
  buildReviewFeedbackSection,
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

const PLAN_FORMAT = '# Plan Format — 完全形の6セクション\n問題 / 選択肢 / 方針 / 契約 / 検証 / 見積り';
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
  assert.ok(prompt.includes('完全形の6セクション'));
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

test('buildPlanTaskPrompt: ASK_PDM 出力が issue comment として投稿されることを明示する（省略禁止・全成果物を含める契約）', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  // この出力全体が issue comment として投稿されます — 省略禁止の根拠文言（#239 AC1）
  assert.ok(prompt.includes('この出力全体が issue comment として投稿されます'));
  // 子 issue block 群・却下候補をすべて出力した上で — 全成果物を含める契約（#239 AC1）
  assert.ok(prompt.includes('子 issue block 群・却下候補をすべて出力した上で'));
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

test('buildPlanTaskPrompt: 書式契約（Title 必須・トポロジカル順・後方参照のみ）を明文化する (#201 Wave4)', () => {
  const prompt = buildPlanTaskPrompt(PLAN_CTX);
  assert.ok(prompt.includes('書式契約'));
  assert.ok(prompt.includes('`Title:` 行は各 block の必須の先頭行です'));
  assert.ok(prompt.includes('トポロジカル順'));
  assert.ok(prompt.includes('後方参照のみ'));
  assert.ok(prompt.includes('前方参照・自己参照・存在しない番号・重複参照は書式違反です'));
});

test('buildPlanTaskPrompt: 書式検証 NG の所見は buildReviewFeedbackSection 経由で注入される (#201 Wave4)', () => {
  const withFeedback = buildPlanTaskPrompt({ ...PLAN_CTX, reviewFeedback: 'plan block 1: "plan#5" references a non-existent plan block' });
  assert.ok(withFeedback.includes('## 前回 review 所見（FILE_CHILDREN 書式検証 NG）'));
  assert.ok(withFeedback.includes('plan block 1: "plan#5" references a non-existent plan block'));
  assert.ok(withFeedback.includes('握り潰し禁止'));
  assert.ok(!buildPlanTaskPrompt(PLAN_CTX).includes('前回 review 所見'));
});

// --- buildReviewFeedbackSection (#192 Major#2 — 所見注入の共通の口) ---

test('buildReviewFeedbackSection: renders source, findings, and the 握り潰し禁止 contract', () => {
  const section = buildReviewFeedbackSection({
    source: 'PLAN_REVIEW RED',
    findings: '1. acceptance criteria が曖昧\n2. 検証方法が未記載\nVERDICT: RED',
  });
  assert.ok(section.includes('## 前回 review 所見（PLAN_REVIEW RED）'));
  assert.ok(section.includes('acceptance criteria が曖昧'));
  assert.ok(section.includes('検証方法が未記載'));
  assert.ok(section.includes('握り潰し禁止'));
});

test('buildReviewFeedbackSection: standalone VERDICT lines are stripped from findings', () => {
  const section = buildReviewFeedbackSection({ source: 'PLAN_REVIEW RED', findings: 'fix this\nVERDICT: RED' });
  assert.ok(!section.includes('VERDICT: RED'));
});

test('buildReviewFeedbackSection: empty / missing / verdict-only findings -> empty string', () => {
  assert.equal(buildReviewFeedbackSection({ source: 'PLAN_REVIEW RED', findings: '' }), '');
  assert.equal(buildReviewFeedbackSection({ source: 'PLAN_REVIEW RED', findings: undefined }), '');
  assert.equal(buildReviewFeedbackSection({ source: 'PLAN_REVIEW RED', findings: 'VERDICT: RED' }), '');
});

test('buildReviewFeedbackSection: source label is caller-defined (LAND review 前置での再利用の口, #188)', () => {
  const section = buildReviewFeedbackSection({ source: 'LAND review CHANGES', findings: 'split the commit' });
  assert.ok(section.includes('## 前回 review 所見（LAND review CHANGES）'));
});

// --- buildLandReworkPrompt (#201 分解 12 / #188 CHANGES 差し戻し) ---

const REWORK_CTX = {
  issueNumber: 42,
  issueTitle: 'fix: the thing',
  issueBody: 'plan body',
  comments: [],
  reviewFeedback: '1. missing test\n2. wrong path\nVERDICT: CHANGES',
  round: 1,
  maxRounds: 2,
  prNumber: 77,
};

test('buildLandReworkPrompt: 所見は buildReviewFeedbackSection の単一の口経由（握り潰し禁止付き）', () => {
  const prompt = buildLandReworkPrompt(REWORK_CTX);
  assert.ok(prompt.includes('## 前回 review 所見（LAND review CHANGES — PR #77 修正周回 1/2）'));
  assert.ok(prompt.includes('missing test'));
  assert.ok(prompt.includes('握り潰し禁止'));
  // 注入所見の bare VERDICT 行は落ちる（末尾の verdict 指示のみが VERDICT を含む）
  assert.ok(!prompt.includes('VERDICT: CHANGES'));
});

test('buildLandReworkPrompt: 同一 worktree 追い commit 契約（rebase/amend/reset・push・新 PR の禁止）', () => {
  const prompt = buildLandReworkPrompt(REWORK_CTX);
  assert.match(prompt, /^issue #42 \/ stage: IMPLEMENT/);
  assert.ok(prompt.includes('inner-issue-42'));
  assert.ok(prompt.includes('inner/issue-42'));
  assert.ok(prompt.includes('追い commit として積む'));
  assert.ok(prompt.includes('force-push 不可'));
  assert.ok(prompt.includes('新しい PR・branch を作らない'));
  assert.ok(prompt.includes('`git add -A` / `git add .` は禁止'));
  assert.ok(prompt.includes('VERDICT: <TOKEN>'));
  assert.ok(prompt.includes('IMPL_DONE | ESCALATE'));
});

test('buildLandReworkPrompt: zero-commit（全指摘却下・理由列挙）を適法とする（#188 対応可否）', () => {
  const prompt = buildLandReworkPrompt(REWORK_CTX);
  assert.ok(prompt.includes('commit を作らず'));
  assert.ok(prompt.includes('再 review が対応表明を審査'));
});

test('buildLandReworkPrompt: issue 本文と comments が文脈として注入される', () => {
  const prompt = buildLandReworkPrompt({ ...REWORK_CTX, comments: COMMENTS });
  assert.ok(prompt.includes('plan body'));
  assert.ok(prompt.includes('裁定・申し送り'));
  assert.ok(prompt.includes('監査役裁定: arm は PR 作成時。'));
});

test('buildLandReworkPrompt: 空所見は fail-closed（throw）', () => {
  assert.throws(() => buildLandReworkPrompt({ ...REWORK_CTX, reviewFeedback: '' }), /reviewFeedback is required/);
  assert.throws(() => buildLandReworkPrompt({ ...REWORK_CTX, reviewFeedback: 'VERDICT: CHANGES' }), /reviewFeedback is required/);
});

test('buildLandReworkPrompt: STAGE_PROMPT_BUILDERS には載せない（IMPLEMENT の正規 prompt を壊さない）', () => {
  assert.ok(!Object.values(STAGE_PROMPT_BUILDERS).includes(buildLandReworkPrompt));
});

// --- TASK_PLAN prompt: RED 所見の注入 (#192 Major#2) ---

const TASK_PLAN_CTX = {
  issueNumber: 42,
  issueTitle: 'fix: the thing',
  issueBody: 'plan me',
  comments: [],
  planFormat: PLAN_FORMAT,
};

test('buildTaskLoopPlanPrompt: reviewFeedback is injected as the 所見 section', () => {
  const prompt = buildTaskLoopPlanPrompt({ ...TASK_PLAN_CTX, reviewFeedback: '検証方法が未記載\nVERDICT: RED' });
  assert.ok(prompt.includes('## 前回 review 所見（PLAN_REVIEW RED）'));
  assert.ok(prompt.includes('検証方法が未記載'));
});

test('buildTaskLoopPlanPrompt: no reviewFeedback -> no 所見 section (initial attempt)', () => {
  const prompt = buildTaskLoopPlanPrompt(TASK_PLAN_CTX);
  assert.ok(!prompt.includes('前回 review 所見'));
  const promptEmpty = buildTaskLoopPlanPrompt({ ...TASK_PLAN_CTX, reviewFeedback: '' });
  assert.ok(!promptEmpty.includes('前回 review 所見'));
});

// --- PLAN_REVIEW prompt: comments 注入 (#192 Minor#4) ---

const PLAN_REVIEW_CTX = {
  issueNumber: 42,
  issueTitle: 'fix: the thing',
  issueBody: 'body',
  planText: 'the plan under review',
};

test('buildPlanReviewPrompt: comments (裁定・申し送り) are injected for the reviewer', () => {
  const prompt = buildStagePrompt('PLAN_REVIEW', { ...PLAN_REVIEW_CTX, comments: COMMENTS });
  assert.ok(prompt.includes('裁定・申し送り'));
  assert.ok(prompt.includes('監査役裁定: arm は PR 作成時。'));
  assert.ok(prompt.includes('the plan under review'), 'plan text still present');
});

test('buildPlanReviewPrompt: no comments -> no 裁定 section', () => {
  const prompt = buildStagePrompt('PLAN_REVIEW', { ...PLAN_REVIEW_CTX, comments: [] });
  assert.ok(!prompt.includes('裁定・申し送り'));
  assert.ok(prompt.trimEnd().endsWith('<TOKEN> は次のいずれか: PASS | RED'));
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
