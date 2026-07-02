import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  nextState,
  nextPlanLoopState,
  decideResumeState,
  buildManifestEntry,
  buildSkippedPlanEntry,
  buildManifest,
  readManifestStages,
  stagePermissions,
  stageCwd,
  buildReceiptArgs,
  tailLines,
  MAX_CYCLES,
  isCodexSandboxEpermTriageResult,
  hasApprovedPlanMarker,
  extractApprovedPlan,
  selectRunPlan,
  parseDriverArgs,
  parseApprovedPlanForIssue,
  buildImplementationIssueBody,
  parseGhIssueNumber,
  collectReviewHistory,
  buildReviewHistorySummary,
  buildEscalationMarkdown,
} from './inner-loop.mjs';
import {
  buildStagePrompt,
  buildResearchPrompt,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildImplementPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  buildTriagePrompt,
} from './inner-loop-prompts.mjs';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- parseVerdict ---

test('parseVerdict: all valid tokens parse correctly', () => {
  const tokens = ['PLAN_READY', 'ESCALATE', 'IMPL_DONE', 'PASS', 'CHANGES', 'GREEN', 'RED', 'KNOWN', 'NOVEL'];
  for (const token of tokens) {
    const result = parseVerdict(`some agent output\nmore text\nVERDICT: ${token}`);
    assert.equal(result, token, `expected ${token} to parse`);
  }
});

test('parseVerdict: missing VERDICT line → null', () => {
  const result = parseVerdict('the agent said something but forgot the verdict line');
  assert.equal(result, null);
});

test('parseVerdict: empty string → null', () => {
  assert.equal(parseVerdict(''), null);
});

test('parseVerdict: null/undefined input → null', () => {
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(undefined), null);
});

test('parseVerdict: unrecognized token → null (not silently accepted)', () => {
  const result = parseVerdict('VERDICT: MAYBE_LATER');
  assert.equal(result, null);
});

test('parseVerdict: multiple VERDICT lines → last one wins (envelope result tail)', () => {
  const result = parseVerdict('VERDICT: CHANGES\nsome more reasoning\nVERDICT: PASS');
  assert.equal(result, 'PASS');
});

test('parseVerdict: VERDICT embedded mid-text still parses (last match)', () => {
  const result = parseVerdict('I reviewed everything.\n\nVERDICT: GREEN\n');
  assert.equal(result, 'GREEN');
});

// --- ADR 0016: approved plan marker / loop selection ---

test('hasApprovedPlanMarker: detects exact H2 approved plan marker', () => {
  assert.equal(hasApprovedPlanMarker('Intro\n## Plan (approved)\nDo it'), true);
  assert.equal(hasApprovedPlanMarker('Intro\n## Plan (approved)   \nDo it'), true);
});

test('hasApprovedPlanMarker: rejects non-exact headings', () => {
  assert.equal(hasApprovedPlanMarker('### Plan (approved)\nDo it'), false);
  assert.equal(hasApprovedPlanMarker('## Plan (approved) extra\nDo it'), false);
  assert.equal(hasApprovedPlanMarker(' ## Plan (approved)\nDo it'), false);
});

test('extractApprovedPlan: returns content through EOF so nested H2 plan sections are preserved', () => {
  const body = [
    '# issue',
    '',
    '## Plan (approved)',
    'Step 1',
    '### Details',
    'Keep this.',
    '## Scope',
    'Keep this H2 too.',
    '## Verification',
    'Keep this final section.',
  ].join('\n');
  assert.equal(
    extractApprovedPlan(body),
    'Step 1\n### Details\nKeep this.\n## Scope\nKeep this H2 too.\n## Verification\nKeep this final section.',
  );
});

test('selectRunPlan: impl-loop with approved plan marker skips PLAN', () => {
  const result = selectRunPlan({ mode: 'impl', issueBody: '## Plan (approved)\nImplement X.' });
  assert.equal(result.mode, 'impl');
  assert.equal(result.skipPlan, true);
  assert.equal(result.initialState, 'IMPLEMENT');
  assert.deepEqual(result.stages, ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']);
  assert.equal(result.approvedPlan, 'Implement X.');
});

test('selectRunPlan: impl-loop without marker remains backward compatible', () => {
  const result = selectRunPlan({ mode: 'impl', issueBody: 'No approved plan.' });
  assert.equal(result.skipPlan, false);
  assert.equal(result.initialState, 'PLAN');
  assert.deepEqual(result.stages, ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']);
});

test('selectRunPlan: plan-loop uses ADR 0016 stage sequence', () => {
  const result = selectRunPlan({ mode: 'plan', issueBody: 'needs plan' });
  assert.equal(result.initialState, 'RESEARCH');
  assert.deepEqual(result.stages, ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'ISSUE_CREATE', 'CLOSE_SOURCE']);
});

test('buildSkippedPlanEntry: creates synthetic skipped PLAN_READY manifest entry', () => {
  const entry = buildSkippedPlanEntry('approved plan text');
  assert.equal(entry.stage, 'PLAN');
  assert.equal(entry.verdict, 'PLAN_READY');
  assert.equal(entry.session_id, null);
  assert.equal(entry.result_text, 'approved plan text');
  assert.equal(entry.skipped, true);
});

test('parseDriverArgs: parses --plan mode and backend flags', () => {
  const parsed = parseDriverArgs(['--plan', '41', '--dry-run', '--backend-plan', 'claude']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.mode, 'plan');
  assert.equal(parsed.issueNumber, 41);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.backendFlags.stages.PLAN, 'claude');
});

test('parseDriverArgs: parses impl mode with positional issue', () => {
  const parsed = parseDriverArgs(['41', '--resume']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.mode, 'impl');
  assert.equal(parsed.issueNumber, 41);
  assert.equal(parsed.resume, true);
});

test('parseApprovedPlanForIssue: extracts machine-readable issue fields', () => {
  const parsed = parseApprovedPlanForIssue([
    'Title: feat: add thing',
    'Depends-on: #38',
    'Touches: scripts/inner-loop.mjs, scripts/inner-loop-prompts.mjs',
    'Plan body',
  ].join('\n'));
  assert.deepEqual(parsed, {
    title: 'feat: add thing',
    dependsOn: '#38',
    touches: 'scripts/inner-loop.mjs, scripts/inner-loop-prompts.mjs',
  });
});

test('buildImplementationIssueBody: includes approved plan marker and queue hints', () => {
  const body = buildImplementationIssueBody({
    sourceIssueNumber: 41,
    approvedPlan: 'Title: feat: x\nDepends-on: #38\nTouches: scripts/a.mjs\nDo X.\nVERDICT: PLAN_READY',
    dependsOn: '#38',
    touches: 'scripts/a.mjs',
  });
  assert.match(body, /Generated from #41/);
  assert.match(body, /^Depends-on: #38$/m);
  assert.match(body, /^Touches: scripts\/a\.mjs$/m);
  assert.match(body, /^## Plan \(approved\)$/m);
  assert.doesNotMatch(body, /VERDICT: PLAN_READY/);
});

test('parseGhIssueNumber: parses GitHub issue URL', () => {
  assert.equal(parseGhIssueNumber('https://github.com/yutaro0915/lathe/issues/123\n'), 123);
});

// --- nextState: transition table ---

test('nextState: PLAN + PLAN_READY -> IMPLEMENT', () => {
  const { next, cycles } = nextState('PLAN', 'PLAN_READY', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 0);
});

test('nextState: PLAN + ESCALATE -> ESCALATE', () => {
  const { next } = nextState('PLAN', 'ESCALATE', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: IMPLEMENT + IMPL_DONE -> REVIEW', () => {
  const { next } = nextState('IMPLEMENT', 'IMPL_DONE', 0);
  assert.equal(next, 'REVIEW');
});

test('nextState: IMPLEMENT + unexpected verdict -> ESCALATE', () => {
  const { next } = nextState('IMPLEMENT', 'PASS', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: REVIEW + PASS -> VERIFY', () => {
  const { next, cycles } = nextState('REVIEW', 'PASS', 0);
  assert.equal(next, 'VERIFY');
  assert.equal(cycles, 0);
});

test('nextState: REVIEW + CHANGES (cycle 0->1) -> IMPLEMENT', () => {
  const { next, cycles } = nextState('REVIEW', 'CHANGES', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 1);
});

test('nextState: REVIEW + CHANGES within MAX_CYCLES -> IMPLEMENT', () => {
  const { next, cycles } = nextState('REVIEW', 'CHANGES', MAX_CYCLES - 1);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, MAX_CYCLES);
});

test('nextState: REVIEW + CHANGES exceeding MAX_CYCLES -> ESCALATE (CHANGES x3 pattern)', () => {
  // Simulates 3rd CHANGES verdict: cycles already at MAX_CYCLES (2) from two prior CHANGES.
  const { next, cycles } = nextState('REVIEW', 'CHANGES', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, MAX_CYCLES + 1);
});

test('nextState: VERIFY + GREEN -> MERGE', () => {
  const { next } = nextState('VERIFY', 'GREEN', 0);
  assert.equal(next, 'MERGE');
});

test('nextState: VERIFY + RED -> TRIAGE', () => {
  const { next } = nextState('VERIFY', 'RED', 0);
  assert.equal(next, 'TRIAGE');
});

test('nextState: TRIAGE + KNOWN -> IMPLEMENT (cycle increments)', () => {
  const { next, cycles } = nextState('TRIAGE', 'KNOWN', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 1);
});

test('nextState: TRIAGE + KNOWN non-implementable environment failure -> ESCALATE', () => {
  const { next, cycles } = nextState('TRIAGE', 'KNOWN', 0, { nonImplementableKnown: true });
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, 0);
});

test('nextState: TRIAGE + KNOWN exceeding MAX_CYCLES -> ESCALATE', () => {
  const { next } = nextState('TRIAGE', 'KNOWN', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
});

test('nextState: TRIAGE + NOVEL -> ESCALATE', () => {
  const { next } = nextState('TRIAGE', 'NOVEL', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: full happy path RED->TRIAGE->KNOWN->IMPLEMENT', () => {
  const verify = nextState('VERIFY', 'RED', 0);
  assert.equal(verify.next, 'TRIAGE');
  const triage = nextState('TRIAGE', 'KNOWN', verify.cycles);
  assert.equal(triage.next, 'IMPLEMENT');
  assert.equal(triage.cycles, 1);
});

test('nextState: null verdict (unparsable) -> ESCALATE regardless of state', () => {
  for (const state of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { next } = nextState(state, null, 0);
    assert.equal(next, 'ESCALATE', `state=${state} with null verdict should escalate`);
  }
});

test('nextState: unknown state -> ESCALATE', () => {
  const { next } = nextState('BOGUS_STATE', 'PASS', 0);
  assert.equal(next, 'ESCALATE');
});

// --- nextPlanLoopState: ADR 0016 transition table ---

test('nextPlanLoopState: RESEARCH PASS -> PLAN', () => {
  const { next, cycles } = nextPlanLoopState('RESEARCH', 'PASS', 0);
  assert.equal(next, 'PLAN');
  assert.equal(cycles, 0);
});

test('nextPlanLoopState: PLAN PLAN_READY -> PLAN_REVIEW', () => {
  const { next } = nextPlanLoopState('PLAN', 'PLAN_READY', 0);
  assert.equal(next, 'PLAN_REVIEW');
});

test('nextPlanLoopState: PLAN_REVIEW PASS -> ISSUE_CREATE', () => {
  const { next } = nextPlanLoopState('PLAN_REVIEW', 'PASS', 0);
  assert.equal(next, 'ISSUE_CREATE');
});

test('nextPlanLoopState: PLAN_REVIEW CHANGES -> PLAN within max cycles', () => {
  const { next, cycles } = nextPlanLoopState('PLAN_REVIEW', 'CHANGES', 0);
  assert.equal(next, 'PLAN');
  assert.equal(cycles, 1);
});

test('nextPlanLoopState: PLAN_REVIEW CHANGES exceeding max -> ESCALATE', () => {
  const { next, cycles } = nextPlanLoopState('PLAN_REVIEW', 'CHANGES', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, MAX_CYCLES + 1);
});

test('nextPlanLoopState: null verdict -> ESCALATE', () => {
  const { next } = nextPlanLoopState('RESEARCH', null, 0);
  assert.equal(next, 'ESCALATE');
});

// --- buildStagePrompt / prompt interpolation ---

test('buildStagePrompt: PLAN includes issue number, title, body, and VERDICT instruction', () => {
  const prompt = buildStagePrompt('PLAN', { issueNumber: 42, issueTitle: 'Add widget', issueBody: 'Do the thing.' });
  assert.match(prompt, /issue #42/);
  assert.match(prompt, /Add widget/);
  assert.match(prompt, /Do the thing\./);
  assert.match(prompt, /VERDICT: <TOKEN>/);
  assert.match(prompt, /PLAN_READY \| ESCALATE/);
});

test('buildResearchPrompt: includes plan-loop escalation contract', () => {
  const prompt = buildResearchPrompt({ issueNumber: 42, issueTitle: 'Needs plan', issueBody: 'Investigate.' });
  assert.match(prompt, /plan-loop escalation/);
  assert.match(prompt, /裁可/);
  assert.match(prompt, /目標不成立/);
  assert.match(prompt, /依存が既存 open issue と衝突/);
  assert.match(prompt, /未定義の契約/);
  assert.match(prompt, /ロール割当/);
  assert.match(prompt, /規約新設/);
  assert.match(prompt, /実装解が一意でない/);
  assert.match(prompt, /PASS \| ESCALATE/);
});

test('buildPlanPrompt: plan-loop mode requires Title Depends-on Touches', () => {
  const prompt = buildPlanPrompt({
    mode: 'plan-loop',
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    research: 'Facts.',
  });
  assert.match(prompt, /Title:/);
  assert.match(prompt, /Depends-on:/);
  assert.match(prompt, /Touches:/);
  assert.match(prompt, /plan-loop escalation/);
  assert.match(prompt, /最小変更を発明せず ESCALATE/);
  assert.match(prompt, /PLAN_READY \| ESCALATE/);
});

test('buildPlanReviewPrompt: includes plan-loop escalation contract and PASS/CHANGES', () => {
  const prompt = buildPlanReviewPrompt({
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    research: 'Facts.',
    plan: 'Title: feat\nDepends-on:\nTouches: scripts/x.mjs',
  });
  assert.match(prompt, /PLAN-REVIEW/);
  assert.match(prompt, /裁可事項/);
  assert.match(prompt, /目標不成立/);
  assert.match(prompt, /依存衝突/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
});

test('buildStagePrompt: IMPLEMENT includes plan and optional feedback', () => {
  const withoutFeedback = buildStagePrompt('IMPLEMENT', { issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'Do X then Y.' });
  assert.match(withoutFeedback, /Do X then Y\./);
  assert.doesNotMatch(withoutFeedback, /^## 差し戻し指摘/m);

  const withFeedback = buildStagePrompt('IMPLEMENT', {
    issueNumber: 1,
    issueTitle: 'T',
    issueBody: 'B',
    plan: 'Do X then Y.',
    feedback: 'Missing test for edge case.',
  });
  assert.match(withFeedback, /差し戻し指摘/);
  assert.match(withFeedback, /Missing test for edge case\./);
  assert.match(withFeedback, /IMPL_DONE \| ESCALATE/);
});

test('buildImplementPrompt: impl-loop premise break escalates without replanning', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /前提/);
  assert.match(prompt, /再計画せず ESCALATE/);
});

test('buildImplementPrompt: review feedback with undefined design axis escalates instead of inventing a minimal change', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P', feedback: 'decide new role owner' });
  assert.match(prompt, /未定義の契約/);
  assert.match(prompt, /ロール割当/);
  assert.match(prompt, /規約新設/);
  assert.match(prompt, /実装解が一意でない/);
  assert.match(prompt, /最小変更を発明せず ESCALATE/);
});

test('buildStagePrompt: REVIEW includes plan and VERDICT instruction', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /plan text/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
});

test('buildReviewPrompt: asks for comprehensive first-pass review and limits major findings to explicit grounds', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /PLAN と変更全体を一度に照合/);
  assert.match(prompt, /major\/blocker は初回で出し切る/);
  assert.match(prompt, /逐次開示しない/);
  assert.match(prompt, /plan\/rubric\/明文原則違反に限る/);
  assert.match(prompt, /過剰 flag 禁止/);
});

test('buildReviewPrompt: includes review history only when provided', () => {
  const withoutHistory = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.doesNotMatch(withoutHistory, /前周までの REVIEW 履歴/);

  const withHistory = buildReviewPrompt({
    issueNumber: 7,
    plan: 'plan text',
    headSha: 'abc123',
    reviewHistory: '- REVIEW #1 verdict=CHANGES',
  });
  assert.match(withHistory, /前周までの REVIEW 履歴/);
  assert.match(withHistory, /REVIEW #1 verdict=CHANGES/);
  assert.match(withHistory, /前言と矛盾する新指摘/);
  assert.match(withHistory, /撤回/);
  assert.match(withHistory, /理由/);
});

test('buildStagePrompt: VERIFY includes VERDICT instruction', () => {
  const prompt = buildStagePrompt('VERIFY', { issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /GREEN \| RED \| ESCALATE/);
});

// --- receipt issuance is the driver's job, not the prompt's (regression guard) ---
// The driver stamps REVIEW/VERIFY receipts itself (buildReceiptArgs) because an
// agent-issued `LATHE_AGENT=... node scripts/receipt.mjs ...` command silently
// fails the Bash allowlist (env-prefixed commands don't prefix-match
// `Bash(node scripts/receipt.mjs *)`). Prompts must never re-introduce that
// instruction.

test('buildStagePrompt: REVIEW prompt does not instruct the agent to issue a receipt', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

test('buildStagePrompt: VERIFY prompt does not instruct the agent to issue a receipt', () => {
  const prompt = buildStagePrompt('VERIFY', { issueNumber: 7, headSha: 'def456' });
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

// --- F1: IMPLEMENT prompt に役割契約（worktree 内・ネスト禁止）---

test('buildImplementPrompt: contains worktree role contract — in worktree inner-issue-N', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /inner-issue-1/);
  assert.match(prompt, /worktree/);
});

test('buildImplementPrompt: forbids nested subagent spawn', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /subagent/);
  assert.match(prompt, /spawn しない/);
});

test('buildImplementPrompt: worktree name reflects issueNumber', () => {
  const prompt42 = buildImplementPrompt({ issueNumber: 42, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt42, /inner-issue-42/);
  assert.match(prompt42, /inner\/issue-42/);
});

// --- F3: REVIEW/VERIFY prompt に receipt 非発行契約 ---

test('buildReviewPrompt: instructs agent not to issue receipt', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /発行しない/);
  // 既存ガードも維持（receipt.mjs / LATHE_AGENT を含まない）
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

test('buildVerifyPrompt: instructs agent not to issue receipt', () => {
  const prompt = buildVerifyPrompt({ issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /発行しない/);
  // 既存ガードも維持
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

// --- I1: PLAN prompt に impact-scaled rigor ---

test('buildPlanPrompt: contains impact-scaled rigor hint', () => {
  const prompt = buildPlanPrompt({ issueNumber: 42, issueTitle: 'T', issueBody: 'B' });
  assert.match(prompt, /軽量 plan/);
});

// --- I2: REVIEW prompt に inline diff 指定 ---

test('buildReviewPrompt: specifies inline git diff main...HEAD', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /git diff main\.\.\.HEAD/);
  // diff 収集の subagent 委譲禁止も含む
  assert.match(prompt, /subagent に委譲しない/);
});

test('buildStagePrompt: TRIAGE includes verifyResult', () => {
  const prompt = buildStagePrompt('TRIAGE', { issueNumber: 7, verifyResult: 'RED: unit — assertion failed at x.test.mjs:10' });
  assert.match(prompt, /assertion failed at x\.test\.mjs:10/);
  assert.match(prompt, /KNOWN \| NOVEL \| ESCALATE/);
});

test('buildTriagePrompt: Codex sandbox EPERM is escalated, not returned as KNOWN', () => {
  const prompt = buildTriagePrompt({ issueNumber: 7, verifyResult: 'RED: tsc — EPERM writing .tsbuildinfo' });
  assert.match(prompt, /P4/);
  assert.match(prompt, /Codex sandbox EPERM/);
  assert.match(prompt, /VERDICT: ESCALATE/);
  assert.match(prompt, /VERDICT: KNOWN` で IMPLEMENT に戻してはいけません/);
});

test('implementer agent: ambiguous requirements choose smallest change except undefined design axis from feedback escalates', () => {
  const agent = readFileSync(new URL('../.claude/agents/implementer.md', import.meta.url), 'utf8');
  assert.match(agent, /choose the smallest compatible change/);
  assert.match(agent, /差し戻し/);
  assert.match(agent, /設計軸が未定義/);
  assert.match(agent, /ESCALATE/);
});

test('buildStagePrompt: unknown stage throws', () => {
  assert.throws(() => buildStagePrompt('BOGUS', {}), /unknown stage/);
});

test('direct builder exports match buildStagePrompt dispatch', () => {
  const ctx = { issueNumber: 5, issueTitle: 'T', issueBody: 'B', plan: 'P', headSha: 'sha1', verifyResult: 'V' };
  assert.equal(buildResearchPrompt(ctx), buildStagePrompt('RESEARCH', ctx));
  assert.equal(buildPlanPrompt(ctx), buildStagePrompt('PLAN', ctx));
  assert.equal(buildPlanReviewPrompt(ctx), buildStagePrompt('PLAN_REVIEW', ctx));
  assert.equal(buildImplementPrompt(ctx), buildStagePrompt('IMPLEMENT', ctx));
  assert.equal(buildReviewPrompt(ctx), buildStagePrompt('REVIEW', ctx));
  assert.equal(buildVerifyPrompt(ctx), buildStagePrompt('VERIFY', ctx));
  assert.equal(buildTriagePrompt(ctx), buildStagePrompt('TRIAGE', ctx));
});

// --- stagePermissions ---

test('stagePermissions: IMPLEMENT is acceptEdits (edit-capable)', () => {
  const { agent, permissionMode } = stagePermissions('IMPLEMENT');
  assert.equal(agent, 'implementer');
  assert.equal(permissionMode, 'acceptEdits');
});

test('stagePermissions: IMPLEMENT allows git/pnpm/node Bash (needs to commit + verify headlessly)', () => {
  const { allowedTools } = stagePermissions('IMPLEMENT');
  assert.ok(allowedTools.some((t) => t.includes('git')));
  assert.ok(allowedTools.some((t) => t.includes('pnpm')));
  assert.ok(allowedTools.some((t) => t.includes('node')));
});

test('stagePermissions: no stage ever uses bypassPermissions or --bare', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.notEqual(permissionMode, 'bypassPermissions');
    assert.notEqual(permissionMode, '--bare');
  }
});

test('stagePermissions: read-only stages use dontAsk, never bypassPermissions', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.equal(permissionMode, 'dontAsk');
    assert.notEqual(permissionMode, 'bypassPermissions');
  }
});

test('stagePermissions: plan-loop RESEARCH uses researcher and PLAN_REVIEW uses reviewer (ADR 0016: author/approver separation)', () => {
  assert.equal(stagePermissions('RESEARCH').agent, 'researcher');
  assert.equal(stagePermissions('PLAN_REVIEW').agent, 'reviewer');
});

test('stagePermissions: VERIFY allows blanket Bash (needs to run gates; narrow allowlists structurally conflict with verification idioms, #36/#44)', () => {
  const { allowedTools } = stagePermissions('VERIFY');
  assert.ok(allowedTools.includes('Bash'));
});

test('stagePermissions: unknown stage throws', () => {
  assert.throws(() => stagePermissions('BOGUS'), /unknown stage/);
});

// --- stageCwd ---

test('stageCwd: PLAN runs at repo root', () => {
  assert.equal(stageCwd('PLAN', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
});

test('stageCwd: plan-loop read stages run at repo root', () => {
  assert.equal(stageCwd('RESEARCH', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
  assert.equal(stageCwd('PLAN_REVIEW', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
});

test('stageCwd: implementation stages run in the worktree', () => {
  for (const stage of ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    assert.equal(stageCwd(stage, '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo/.claude/worktrees/inner-issue-1');
  }
});

// --- manifest entry / manifest shape ---

test('buildManifestEntry: fills defaults for missing optional fields', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: 'sess-1', verdict: 'PLAN_READY', costUsd: 0.05 });
  assert.equal(entry.stage, 'PLAN');
  assert.equal(entry.session_id, 'sess-1');
  assert.equal(entry.verdict, 'PLAN_READY');
  assert.equal(entry.cost_usd, 0.05);
  assert.equal(entry.duration_ms, null);
  assert.ok(entry.ts);
});

test('buildManifestEntry: null sessionId/verdict/costUsd -> null fields (not undefined)', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: null, verdict: null, costUsd: null });
  assert.equal(entry.session_id, null);
  assert.equal(entry.verdict, null);
  assert.equal(entry.cost_usd, null);
});

test('buildManifestEntry: backend field is recorded when provided (ADR 0014)', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.01, backend: 'codex' });
  assert.equal(entry.backend, 'codex');
});

test('buildManifestEntry: backend omitted -> null (backward compatible)', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.01 });
  assert.equal(entry.backend, null);
});

test('buildManifestEntry: records duration even when cost is null', () => {
  const entry = buildManifestEntry({
    stage: 'VERIFY',
    sessionId: 'exec-session-123',
    verdict: 'GREEN',
    costUsd: null,
    durationMs: 321,
    backend: 'codex',
  });
  assert.equal(entry.cost_usd, null);
  assert.equal(entry.duration_ms, 321);
});

test('buildManifestEntry: records resume fields when provided', () => {
  const entry = buildManifestEntry({
    stage: 'IMPLEMENT',
    sessionId: 'exec-session-123',
    verdict: 'IMPL_DONE',
    costUsd: null,
    headSha: 'abc123',
    resultText: 'implementation notes\nVERDICT: IMPL_DONE',
  });
  assert.equal(entry.head_sha, 'abc123');
  assert.equal(entry.result_text, 'implementation notes\nVERDICT: IMPL_DONE');
});

test('buildManifest: wraps issue number and stages array', () => {
  const stages = [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.1 })];
  const manifest = buildManifest(25, stages);
  assert.equal(manifest.issue, 25);
  assert.equal(manifest.stages.length, 1);
  assert.equal(manifest.stages[0].stage, 'PLAN');
});

// --- readManifestStages ---

function makeTempDir(testId) {
  const dir = join(tmpdir(), `lathe-inner-loop-test-${testId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('readManifestStages: missing file -> []', () => {
  const dir = makeTempDir('missing');
  const result = readManifestStages(join(dir, 'issue-1.json'));
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: malformed JSON -> []', () => {
  const dir = makeTempDir('malformed');
  const path = join(dir, 'issue-1.json');
  writeFileSync(path, '{not valid json', 'utf8');
  const result = readManifestStages(path);
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: valid manifest -> returns stages array', () => {
  const dir = makeTempDir('valid');
  const path = join(dir, 'issue-1.json');
  const manifest = buildManifest(1, [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.01 })]);
  writeFileSync(path, JSON.stringify(manifest), 'utf8');
  const result = readManifestStages(path);
  assert.equal(result.length, 1);
  assert.equal(result[0].stage, 'PLAN');
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: stages not an array -> []', () => {
  const dir = makeTempDir('bad-shape');
  const path = join(dir, 'issue-1.json');
  writeFileSync(path, JSON.stringify({ issue: 1, stages: 'oops' }), 'utf8');
  const result = readManifestStages(path);
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

// --- review history transport / escalation summary ---

test('collectReviewHistory: extracts all REVIEW entries with verdict, head, ts, excerpt, and contradiction markers', () => {
  const history = collectReviewHistory([
    buildManifestEntry({ stage: 'PLAN', sessionId: 's-plan', verdict: 'PLAN_READY', costUsd: 0.01, resultText: 'plan' }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: plan と違う\nVERDICT: CHANGES',
    }),
    buildManifestEntry({ stage: 'IMPLEMENT', sessionId: 's-impl', verdict: 'IMPL_DONE', costUsd: 0.03, headSha: 'sha-impl', resultText: 'done' }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'CHANGES',
      costUsd: 0.04,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: '前言と矛盾するため撤回が必要\nVERDICT: CHANGES',
    }),
  ]);

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => entry.ordinal), [1, 2]);
  assert.equal(history[0].verdict, 'CHANGES');
  assert.equal(history[0].headSha, 'sha-review-1');
  assert.equal(history[0].ts, '2026-07-02T00:00:00.000Z');
  assert.match(history[0].excerpt, /major: plan と違う/);
  assert.equal(history[0].hasContradictionMarker, false);
  assert.equal(history[1].hasContradictionMarker, true);
});

test('buildReviewHistorySummary: returns empty without REVIEW entries and a prompt-ready summary with REVIEW entries', () => {
  assert.equal(buildReviewHistorySummary([]), '');

  const summary = buildReviewHistorySummary([
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: first issue\nVERDICT: CHANGES',
    }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'PASS',
      costUsd: 0.03,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: 'withdraw previous concern\nVERDICT: PASS',
    }),
  ]);

  assert.match(summary, /REVIEW #1/);
  assert.match(summary, /verdict: CHANGES/);
  assert.match(summary, /head_sha: sha-review-1/);
  assert.match(summary, /major: first issue/);
  assert.match(summary, /REVIEW #2/);
  assert.match(summary, /contradiction_marker: yes/);
});

test('buildEscalationMarkdown: includes all REVIEW rounds, not only the final stage excerpt', () => {
  const reviewHistory = collectReviewHistory([
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: first issue\nVERDICT: CHANGES',
    }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'ESCALATE',
      costUsd: 0.03,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: '前言と矛盾\nVERDICT: ESCALATE',
    }),
  ]);
  const markdown = buildEscalationMarkdown({
    issueNumber: 48,
    stage: 'REVIEW',
    verdict: 'ESCALATE',
    ts: '2026-07-02T00:11:00.000Z',
    resultExcerpt: 'final reviewer excerpt',
    reviewHistory,
  });

  assert.match(markdown, /# escalation — issue #48/);
  assert.match(markdown, /## REVIEW verdict history/);
  assert.match(markdown, /REVIEW #1/);
  assert.match(markdown, /major: first issue/);
  assert.match(markdown, /REVIEW #2/);
  assert.match(markdown, /contradiction_marker: yes/);
  assert.match(markdown, /final reviewer excerpt/);
});

// --- resume decision ---

const cleanWorktree = (headSha = 'sha-1') => ({
  exists: true,
  branchMatches: true,
  clean: true,
  headSha,
});

test('decideResumeState: PLAN_READY + IMPL_DONE resumes at REVIEW and skips completed stages', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-1',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
    ],
    worktree: cleanWorktree('sha-1'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'REVIEW');
  assert.equal(result.plan, 'plan text\nVERDICT: PLAN_READY');
  assert.deepEqual(result.skipped, ['PLAN', 'IMPLEMENT']);
  assert.deepEqual(result.receiptsToStamp, []);
});

test('decideResumeState: REVIEW PASS resumes at VERIFY and restamps review receipt', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-2',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-2',
        resultText: 'review ok\nVERDICT: PASS',
      }),
    ],
    worktree: cleanWorktree('sha-2'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'VERIFY');
  assert.deepEqual(result.receiptsToStamp, [{ stage: 'REVIEW', headSha: 'sha-2', verdict: 'PASS' }]);
});

test('decideResumeState: VERIFY GREEN resumes at MERGE and restamps merge receipts', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-3',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-3',
        resultText: 'review ok\nVERDICT: PASS',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify',
        verdict: 'GREEN',
        costUsd: 0.04,
        headSha: 'sha-3',
        resultText: 'green\nVERDICT: GREEN',
      }),
    ],
    worktree: cleanWorktree('sha-3'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'MERGE');
  assert.deepEqual(result.receiptsToStamp, [
    { stage: 'REVIEW', headSha: 'sha-3', verdict: 'PASS' },
    { stage: 'VERIFY', headSha: 'sha-3', verdict: 'GREEN' },
  ]);
});

test('decideResumeState: REVIEW CHANGES restores feedback and resumes at IMPLEMENT', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-4',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'CHANGES',
        costUsd: 0.03,
        headSha: 'sha-4',
        resultText: 'fix this\nVERDICT: CHANGES',
      }),
    ],
    worktree: cleanWorktree('sha-4'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENT');
  assert.equal(result.cycles, 1);
  assert.equal(result.feedback, 'fix this\nVERDICT: CHANGES');
});

test('decideResumeState: ESCALATE verdict reruns the same stage instead of skipping it', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'ESCALATE',
        costUsd: 0.02,
        headSha: 'sha-5',
        resultText: 'blocked\nVERDICT: ESCALATE',
      }),
    ],
    worktree: cleanWorktree('sha-5'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENT');
  assert.deepEqual(result.skipped, ['PLAN']);
});

test('decideResumeState: legacy PLAN_READY without result_text is not resumable', () => {
  const result = decideResumeState({
    stages: [
      {
        stage: 'PLAN',
        session_id: 's-plan',
        verdict: 'PLAN_READY',
        cost_usd: 0.01,
        duration_ms: 1,
        ts: '2026-07-02T00:00:00.000Z',
        backend: 'codex',
      },
    ],
    worktree: cleanWorktree('sha-6'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /legacy manifest lacks result_text/);
});

test('decideResumeState: missing worktree is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
    ],
    worktree: { exists: false, branchMatches: false, clean: false, headSha: null },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing worktree/);
});

test('decideResumeState: dirty worktree is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
    ],
    worktree: { exists: true, branchMatches: true, clean: false, headSha: 'sha-7' },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /dirty worktree/);
});

test('decideResumeState: sha mismatch is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'manifest-sha',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
    ],
    worktree: cleanWorktree('actual-sha'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /sha mismatch/);
});

// --- buildReceiptArgs: driver stamps REVIEW/VERIFY receipts itself ---

test('buildReceiptArgs: REVIEW + PASS builds review receipt argv with reviewer agent', () => {
  const result = buildReceiptArgs('REVIEW', 'abc123', 'PASS');
  assert.equal(result.command, 'node');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'review', 'abc123', 'PASS']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'reviewer' });
});

test('buildReceiptArgs: REVIEW + CHANGES builds review receipt argv', () => {
  const result = buildReceiptArgs('REVIEW', 'abc123', 'CHANGES');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'review', 'abc123', 'CHANGES']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'reviewer' });
});

test('buildReceiptArgs: VERIFY + GREEN builds verify receipt argv with verifier agent', () => {
  const result = buildReceiptArgs('VERIFY', 'def456', 'GREEN');
  assert.equal(result.command, 'node');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'verify', 'def456', 'GREEN']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'verifier' });
});

test('buildReceiptArgs: VERIFY + RED builds verify receipt argv', () => {
  const result = buildReceiptArgs('VERIFY', 'def456', 'RED');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'verify', 'def456', 'RED']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'verifier' });
});

test('buildReceiptArgs: REVIEW + ESCALATE -> null (not a receipt-eligible verdict)', () => {
  assert.equal(buildReceiptArgs('REVIEW', 'abc123', 'ESCALATE'), null);
});

test('buildReceiptArgs: VERIFY + ESCALATE -> null (not a receipt-eligible verdict)', () => {
  assert.equal(buildReceiptArgs('VERIFY', 'def456', 'ESCALATE'), null);
});

test('buildReceiptArgs: non-receipt stages (PLAN/IMPLEMENT/TRIAGE) -> null', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'IMPLEMENT', 'TRIAGE']) {
    assert.equal(buildReceiptArgs(stage, 'abc123', 'PLAN_READY'), null, `stage=${stage} should not be receipt-eligible`);
  }
});

// --- tailLines: merge escalation output capture ---

test('tailLines: returns last n lines (default 30)', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const result = tailLines(lines.join('\n'));
  const resultLines = result.split('\n');
  assert.equal(resultLines.length, 30);
  assert.equal(resultLines[0], 'line-10');
  assert.equal(resultLines[29], 'line-39');
});

test('tailLines: shorter input returned unchanged (trimmed)', () => {
  assert.equal(tailLines('  a\nb\nc  '), 'a\nb\nc');
});

test('tailLines: custom n', () => {
  const result = tailLines('a\nb\nc\nd', 2);
  assert.equal(result, 'c\nd');
});

test('tailLines: null/undefined -> empty string', () => {
  assert.equal(tailLines(null), '');
  assert.equal(tailLines(undefined), '');
});

// --- P4: non-implementable Codex sandbox EPERM triage ---

test('isCodexSandboxEpermTriageResult: detects playbook P4 KNOWN output', () => {
  const result = [
    '既知（playbook P4）: Codex sandbox EPERM。',
    'connect EPERM 127.0.0.1:55432 and .tsbuildinfo write failed.',
    'VERDICT: KNOWN',
  ].join('\n');
  assert.equal(isCodexSandboxEpermTriageResult(result), true);
});

test('isCodexSandboxEpermTriageResult: does not classify ordinary known failures as P4', () => {
  const result = [
    '既知（playbook P1）: cold e2e flake。',
    'warm rerun passed.',
    'VERDICT: KNOWN',
  ].join('\n');
  assert.equal(isCodexSandboxEpermTriageResult(result), false);
});
