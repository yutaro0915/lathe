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
  MAX_CYCLES,
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

test('buildStagePrompt: REVIEW includes headSha in receipt command and plan', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /receipt\.mjs review abc123/);
  assert.match(prompt, /plan text/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
});

test('buildStagePrompt: VERIFY includes headSha in receipt command', () => {
  const prompt = buildStagePrompt('VERIFY', { issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /receipt\.mjs verify def456/);
  assert.match(prompt, /GREEN \| RED \| ESCALATE/);
});

test('buildStagePrompt: TRIAGE includes verifyResult', () => {
  const prompt = buildStagePrompt('TRIAGE', { issueNumber: 7, verifyResult: 'RED: unit — assertion failed at x.test.mjs:10' });
  assert.match(prompt, /assertion failed at x\.test\.mjs:10/);
  assert.match(prompt, /KNOWN \| NOVEL \| ESCALATE/);
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
  assert.ok(entry.ts);
});

test('buildManifestEntry: null sessionId/verdict/costUsd -> null fields (not undefined)', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: null, verdict: null, costUsd: null });
  assert.equal(entry.session_id, null);
  assert.equal(entry.verdict, null);
  assert.equal(entry.cost_usd, null);
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
