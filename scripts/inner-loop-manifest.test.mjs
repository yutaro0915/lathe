// Tests for manifest building/reading, escalation markdown, worktree naming,
// and the shrunk resume walker (#116: the walkable stages are the task-loop
// stages; a completed walk resumes at LAND).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildManifestEntry,
  backendCostSourceForEnvelope,
  buildManifest,
  manifestPathFor,
  worktreeNameFor,
  readManifestStages,
  buildEscalationMarkdown,
  decideResumeState,
} from './inner-loop.mjs';

// --- buildManifestEntry ---

test('buildManifestEntry: fills defaults for missing optional fields', () => {
  const entry = buildManifestEntry({ stage: 'IMPLEMENT', sessionId: 's1', verdict: 'IMPL_DONE' });
  assert.equal(entry.stage, 'IMPLEMENT');
  assert.equal(entry.session_id, 's1');
  assert.equal(entry.verdict, 'IMPL_DONE');
  assert.equal(entry.backend_cost_usd, null);
  assert.equal(entry.backend_cost_source, null);
  assert.equal(entry.duration_ms, null);
  assert.equal(entry.backend, null);
  assert.equal(entry.head_sha, null);
  assert.equal(entry.result_text, null);
  assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0);
  assert.ok(!('backend_model' in entry));
  assert.ok(!('backend_token_usage' in entry));
  assert.ok(!('skipped' in entry));
});

test('buildManifestEntry: records backend evidence fields when provided (ADR 0014)', () => {
  const entry = buildManifestEntry({
    stage: 'IMPLEMENT',
    sessionId: 's2',
    verdict: 'IMPL_DONE',
    backendCostUsd: 0.42,
    backendCostSource: 'codex.jsonl.turn.completed.usage',
    backendModel: 'gpt-5.3-codex',
    backendTokenUsage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 },
    durationMs: 1234,
    backend: 'codex',
    headSha: 'abc123',
    resultText: 'done\nVERDICT: IMPL_DONE',
  });
  assert.equal(entry.backend_cost_usd, 0.42);
  assert.equal(entry.backend_cost_source, 'codex.jsonl.turn.completed.usage');
  assert.equal(entry.backend_model, 'gpt-5.3-codex');
  assert.deepEqual(entry.backend_token_usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 });
  assert.equal(entry.duration_ms, 1234);
  assert.equal(entry.backend, 'codex');
  assert.equal(entry.head_sha, 'abc123');
});

test('buildManifestEntry: legacy costUsd input becomes backend_cost_usd without emitting cost_usd', () => {
  const entry = buildManifestEntry({ stage: 'IMPLEMENT', sessionId: null, verdict: null, costUsd: 0.05 });
  assert.equal(entry.backend_cost_usd, 0.05);
  assert.ok(!('cost_usd' in entry));
});

test('backendCostSourceForEnvelope: labels backend envelope cost sources', () => {
  assert.equal(backendCostSourceForEnvelope({ backend: 'claude' }), 'claude.result.total_cost_usd');
  assert.equal(backendCostSourceForEnvelope({ backend: 'codex', total_cost_usd: 0.1 }), 'codex.jsonl.explicit_cost');
  assert.equal(backendCostSourceForEnvelope({ backend: 'codex' }), null);
  assert.equal(backendCostSourceForEnvelope({ backend: 'codex', backend_cost_source: 'codex.jsonl.turn.completed.usage' }), 'codex.jsonl.turn.completed.usage');
});

// --- buildManifest / paths / naming ---

test('buildManifest: wraps issue number and stages array', () => {
  const manifest = buildManifest(9, [{ stage: 'IMPLEMENT' }], { mode: 'plan-task' });
  assert.deepEqual(manifest, { issue: 9, mode: 'plan-task', stages: [{ stage: 'IMPLEMENT' }] });
});

test('manifestPathFor: issue-keyed manifest path', () => {
  assert.match(manifestPathFor(42), /\.lathe\/runs\/issue-42\.json$/);
});

test('worktreeNameFor: inner-issue naming', () => {
  assert.deepEqual(worktreeNameFor(42), { branch: 'inner/issue-42', dirName: 'inner-issue-42' });
});

// --- readManifestStages ---

test('readManifestStages: missing / malformed / non-array -> []', () => {
  const dir = join(tmpdir(), `lathe-manifest-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    assert.deepEqual(readManifestStages(join(dir, 'nope.json')), []);
    const malformed = join(dir, 'bad.json');
    writeFileSync(malformed, '{not json', 'utf8');
    assert.deepEqual(readManifestStages(malformed), []);
    const notArray = join(dir, 'not-array.json');
    writeFileSync(notArray, JSON.stringify({ issue: 1, stages: 'x' }), 'utf8');
    assert.deepEqual(readManifestStages(notArray), []);
    const valid = join(dir, 'ok.json');
    writeFileSync(valid, JSON.stringify({ issue: 1, stages: [{ stage: 'IMPLEMENT' }] }), 'utf8');
    assert.deepEqual(readManifestStages(valid), [{ stage: 'IMPLEMENT' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- buildEscalationMarkdown ---

test('buildEscalationMarkdown: carries stage, verdict, and result excerpt', () => {
  const md = buildEscalationMarkdown({
    issueNumber: 9,
    stage: 'IMPLEMENT',
    verdict: 'ESCALATE',
    ts: '2026-07-07T00:00:00Z',
    resultExcerpt: 'premise mismatch details',
  });
  assert.ok(md.includes('# escalation — issue #9'));
  assert.ok(md.includes('stage: IMPLEMENT'));
  assert.ok(md.includes('verdict: ESCALATE'));
  assert.ok(md.includes('premise mismatch details'));
});

test('buildEscalationMarkdown: null verdict renders as none/unparsable', () => {
  const md = buildEscalationMarkdown({ issueNumber: 9, stage: 'LAND', verdict: null, resultExcerpt: 'landing failed' });
  assert.ok(md.includes('verdict: (none/unparsable)'));
});

test('buildEscalationMarkdown: long excerpts are clipped from the tail', () => {
  const md = buildEscalationMarkdown({
    issueNumber: 9, stage: 'IMPLEMENT', verdict: null,
    resultExcerpt: `HEAD${'x'.repeat(5000)}TAIL`,
  });
  assert.ok(md.includes('TAIL'));
  assert.ok(!md.includes('HEAD'));
});

// --- decideResumeState ---

const CLEAN_WORKTREE = { exists: true, branchMatches: true, clean: true, headSha: 'sha-1' };

function implEntry(overrides = {}) {
  return {
    stage: 'IMPLEMENT',
    verdict: 'IMPL_DONE',
    head_sha: 'sha-1',
    result_text: 'done\nVERDICT: IMPL_DONE',
    ...overrides,
  };
}

test('decideResumeState: IMPL_DONE resumes at LAND with IMPLEMENT skipped', () => {
  const decision = decideResumeState({ stages: [implEntry()], worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, true);
  assert.equal(decision.state, 'LAND');
  assert.deepEqual(decision.skipped, ['IMPLEMENT']);
  assert.equal(decision.headSha, 'sha-1');
});

test('decideResumeState: UNPARSABLE attempt followed by success resumes at LAND', () => {
  const stages = [
    implEntry({ verdict: 'UNPARSABLE', result_text: 'no verdict' }),
    implEntry(),
  ];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, true);
  assert.equal(decision.state, 'LAND');
});

test('decideResumeState: single trailing UNPARSABLE resumes the same stage for retry', () => {
  const stages = [implEntry({ verdict: 'UNPARSABLE', result_text: 'no verdict' })];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, true);
  assert.equal(decision.state, 'IMPLEMENT');
  assert.deepEqual(decision.skipped, []);
});

test('decideResumeState: two consecutive UNPARSABLE attempts are not resumable', () => {
  const stages = [
    implEntry({ verdict: 'UNPARSABLE', result_text: 'no verdict' }),
    implEntry({ verdict: 'UNPARSABLE', result_text: 'still no verdict' }),
  ];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /unparsable retry exhausted/);
});

test('decideResumeState: ESCALATE verdict reruns the same stage instead of skipping it', () => {
  const stages = [implEntry({ verdict: 'ESCALATE', result_text: 'premise broke' })];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, true);
  assert.equal(decision.state, 'IMPLEMENT');
});

test('decideResumeState: ESCALATE without result_text is not resumable (legacy manifest)', () => {
  const stages = [implEntry({ verdict: 'ESCALATE', result_text: undefined })];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /lacks result_text/);
});

test('decideResumeState: IMPLEMENT entry without head_sha is not resumable', () => {
  const stages = [implEntry({ head_sha: undefined })];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /lacks head_sha/);
});

test('decideResumeState: sha mismatch is not resumable', () => {
  const decision = decideResumeState({
    stages: [implEntry({ head_sha: 'sha-other' })],
    worktree: CLEAN_WORKTREE,
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /sha mismatch/);
});

test('decideResumeState: stage order mismatch (legacy multi-stage manifest) is not resumable', () => {
  const stages = [{ stage: 'PLAN', verdict: 'PLAN_READY', result_text: 'plan' }];
  const decision = decideResumeState({ stages, worktree: CLEAN_WORKTREE });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /stage order mismatch: expected IMPLEMENT, got PLAN/);
});

test('decideResumeState: missing manifest / worktree preconditions', () => {
  assert.match(decideResumeState({ stages: [], worktree: CLEAN_WORKTREE }).reason, /no stages/);
  assert.match(decideResumeState({ stages: [implEntry()], worktree: { ...CLEAN_WORKTREE, exists: false } }).reason, /missing worktree/);
  assert.match(decideResumeState({ stages: [implEntry()], worktree: { ...CLEAN_WORKTREE, branchMatches: false } }).reason, /branch mismatch/);
  assert.match(decideResumeState({ stages: [implEntry()], worktree: { ...CLEAN_WORKTREE, clean: false } }).reason, /dirty worktree/);
  assert.match(decideResumeState({ stages: [implEntry()], worktree: { ...CLEAN_WORKTREE, headSha: null } }).reason, /could not determine/);
});
