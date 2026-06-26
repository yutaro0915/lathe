/**
 * Pure unit tests for subagent-link domain logic.
 * No DB, no I/O. Runs via `node --test` (root `pnpm test` glob).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgentIdFromMeta, subagentLinkCandidates } from './subagent-link';
import type { Built } from '../built';

// ---------------------------------------------------------------------------
// spawnAgentIdFromMeta
// ---------------------------------------------------------------------------

describe('spawnAgentIdFromMeta', () => {
  it('returns null for null meta', () => {
    assert.strictEqual(spawnAgentIdFromMeta(null), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(spawnAgentIdFromMeta(''), null);
  });

  it('returns null for non-JSON string', () => {
    assert.strictEqual(spawnAgentIdFromMeta('not-json'), null);
  });

  it('returns null when meta has no agent_id', () => {
    assert.strictEqual(spawnAgentIdFromMeta(JSON.stringify({ tool: 'spawn_agent' })), null);
  });

  it('returns null when agent_id is not a string', () => {
    assert.strictEqual(spawnAgentIdFromMeta(JSON.stringify({ agent_id: 42 })), null);
  });

  it('returns null for array JSON', () => {
    assert.strictEqual(spawnAgentIdFromMeta(JSON.stringify(['a', 'b'])), null);
  });

  it('extracts agent_id from valid meta', () => {
    const meta = JSON.stringify({ tool: 'spawn_agent', agent_id: 'child-abc-123' });
    assert.strictEqual(spawnAgentIdFromMeta(meta), 'child-abc-123');
  });

  it('extracts agent_id when meta has extra fields', () => {
    const meta = JSON.stringify({ tool: 'Agent', agent_id: 'abc', nickname: 'explorer' });
    assert.strictEqual(spawnAgentIdFromMeta(meta), 'abc');
  });
});

// ---------------------------------------------------------------------------
// subagentLinkCandidates
// ---------------------------------------------------------------------------

/** Minimal valid BuiltSession fields needed for the tests. */
function makeSession(id: string): Built['session'] {
  return {
    id,
    projectId: 'test-project',
    project: 'test-project',
    projectGitRemote: null,
    projectCwdHint: null,
    title: id,
    runner: 'codex',
    model: 'gpt-test',
    status: 'done',
    started_at: '2026-06-26 00:00:00',
    ended_at: '2026-06-26 00:00:01',
    duration_ms: 1000,
    turn_count: 1,
    tool_count: 0,
    edit_count: 0,
    bash_count: 0,
    subagent_count: 0,
    error_count: 0,
    token_usage: 100,
    token_in: 50,
    token_out: 50,
    git_branch: 'main',
    commit_count: 0,
    cost_usd: null,
    summary: null,
    harness_version_id: null,
    parent_session_id: null,
    spawned_by_seq: null,
    seq: 1,
  };
}

function makeEvent(
  sessionId: string,
  overrides: Partial<Built['events'][number]> & { id: string },
): Built['events'][number] {
  return {
    session_id: sessionId,
    seq: 1,
    ts: '00:00:00',
    type: 'user_message',
    actor: 'user',
    title: 'hello',
    body: 'hello',
    file_path: null,
    command: null,
    exit_code: null,
    duration_ms: null,
    token_usage: null,
    subagent: null,
    meta: null,
    parent_id: null,
    ...overrides,
  };
}

function makeBuilt(sessionId: string, events: Built['events'][number][]): Built {
  return {
    session: makeSession(sessionId),
    events,
    sessionCommits: [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

describe('subagentLinkCandidates', () => {
  it('returns empty for empty built list', () => {
    assert.deepStrictEqual(subagentLinkCandidates([]), []);
  });

  it('returns empty when no subagent events exist', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', { id: 'e1', type: 'user_message', meta: null }),
      makeEvent('parent-session', { id: 'e2', type: 'bash', meta: null }),
    ]);
    assert.deepStrictEqual(subagentLinkCandidates([built]), []);
  });

  it('returns empty when subagent event has no agent_id in meta', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', {
        id: 'e1',
        type: 'subagent',
        meta: JSON.stringify({ tool: 'spawn_agent' }),
      }),
    ]);
    assert.deepStrictEqual(subagentLinkCandidates([built]), []);
  });

  it('excludes self-links (child session id === parent session id)', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', {
        id: 'e1',
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'parent-session' }),
      }),
    ]);
    assert.deepStrictEqual(subagentLinkCandidates([built]), []);
  });

  it('excludes events that already have a parent_id set', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', {
        id: 'e1',
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-001' }),
        parent_id: 'some-existing-parent-event',
      }),
    ]);
    assert.deepStrictEqual(subagentLinkCandidates([built]), []);
  });

  it('returns a link for a valid spawn event', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', {
        id: 'e1',
        seq: 3,
        type: 'subagent',
        meta: JSON.stringify({ tool: 'spawn_agent', agent_id: 'child-001' }),
        parent_id: null,
      }),
    ]);
    const result = subagentLinkCandidates([built]);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], {
      eventId: 'e1',
      parentSessionId: 'parent-session',
      childSessionId: 'child-001',
      spawnedBySeq: 3,
    });
  });

  it('returns multiple links when multiple spawn events exist in one session', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', {
        id: 'e1',
        seq: 2,
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-001' }),
      }),
      makeEvent('parent-session', {
        id: 'e2',
        seq: 5,
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-002' }),
      }),
    ]);
    const result = subagentLinkCandidates([built]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].childSessionId, 'child-001');
    assert.strictEqual(result[1].childSessionId, 'child-002');
  });

  it('returns links across multiple Built objects', () => {
    const builtA = makeBuilt('session-a', [
      makeEvent('session-a', {
        id: 'eA1',
        seq: 1,
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-a-001' }),
      }),
    ]);
    const builtB = makeBuilt('session-b', [
      makeEvent('session-b', {
        id: 'eB1',
        seq: 2,
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-b-001' }),
      }),
    ]);
    const result = subagentLinkCandidates([builtA, builtB]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].childSessionId, 'child-a-001');
    assert.strictEqual(result[1].childSessionId, 'child-b-001');
  });

  it('skips non-subagent events mixed with subagent events', () => {
    const built = makeBuilt('parent-session', [
      makeEvent('parent-session', { id: 'e1', type: 'user_message', meta: null }),
      makeEvent('parent-session', {
        id: 'e2',
        seq: 4,
        type: 'subagent',
        meta: JSON.stringify({ agent_id: 'child-003' }),
      }),
      makeEvent('parent-session', { id: 'e3', type: 'bash', meta: null }),
    ]);
    const result = subagentLinkCandidates([built]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].childSessionId, 'child-003');
  });
});
