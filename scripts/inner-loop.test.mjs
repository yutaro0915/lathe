import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  nextState,
  buildManifestEntry,
  buildManifest,
  readManifestStages,
  stagePermissions,
  stageCwd,
  buildReceiptArgs,
  tailLines,
  MAX_CYCLES,
  isCodexSandboxEpermTriageResult,
} from './inner-loop.mjs';
import { buildStagePrompt, buildPlanPrompt, buildImplementPrompt, buildReviewPrompt, buildVerifyPrompt, buildTriagePrompt } from './inner-loop-prompts.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// --- buildStagePrompt / prompt interpolation ---

test('buildStagePrompt: PLAN includes issue number, title, body, and VERDICT instruction', () => {
  const prompt = buildStagePrompt('PLAN', { issueNumber: 42, issueTitle: 'Add widget', issueBody: 'Do the thing.' });
  assert.match(prompt, /issue #42/);
  assert.match(prompt, /Add widget/);
  assert.match(prompt, /Do the thing\./);
  assert.match(prompt, /VERDICT: <TOKEN>/);
  assert.match(prompt, /PLAN_READY \| ESCALATE/);
});

test('buildStagePrompt: IMPLEMENT includes plan and optional feedback', () => {
  const withoutFeedback = buildStagePrompt('IMPLEMENT', { issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'Do X then Y.' });
  assert.match(withoutFeedback, /Do X then Y\./);
  assert.doesNotMatch(withoutFeedback, /差し戻し指摘/);

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

test('buildStagePrompt: REVIEW includes plan and VERDICT instruction', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /plan text/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
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

test('buildStagePrompt: unknown stage throws', () => {
  assert.throws(() => buildStagePrompt('BOGUS', {}), /unknown stage/);
});

test('direct builder exports match buildStagePrompt dispatch', () => {
  const ctx = { issueNumber: 5, issueTitle: 'T', issueBody: 'B', plan: 'P', headSha: 'sha1', verifyResult: 'V' };
  assert.equal(buildPlanPrompt(ctx), buildStagePrompt('PLAN', ctx));
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
  for (const stage of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.notEqual(permissionMode, 'bypassPermissions');
    assert.notEqual(permissionMode, '--bare');
  }
});

test('stagePermissions: read-only stages use dontAsk, never bypassPermissions', () => {
  for (const stage of ['PLAN', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.equal(permissionMode, 'dontAsk');
    assert.notEqual(permissionMode, 'bypassPermissions');
  }
});

test('stagePermissions: VERIFY allows pnpm/node Bash (needs to run gates)', () => {
  const { allowedTools } = stagePermissions('VERIFY');
  assert.ok(allowedTools.some((t) => t.includes('pnpm')));
  assert.ok(allowedTools.some((t) => t.includes('node')));
});

test('stagePermissions: unknown stage throws', () => {
  assert.throws(() => stagePermissions('BOGUS'), /unknown stage/);
});

// --- stageCwd ---

test('stageCwd: PLAN runs at repo root', () => {
  assert.equal(stageCwd('PLAN', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
});

test('stageCwd: other stages run in the worktree', () => {
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
  for (const stage of ['PLAN', 'IMPLEMENT', 'TRIAGE']) {
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
