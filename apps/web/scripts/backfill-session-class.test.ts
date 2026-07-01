/**
 * Unit tests for backfill-session-class.ts — pure-function parts only.
 *
 * What this tests:
 *  1. rowToClassifyInput: DB row → SessionClassInput mapping is correct
 *     (the "re-derivability" proof: all inputs come from persistent DB columns)
 *  2. End-to-end class derivation via rowToClassifyInput + classifySession,
 *     covering representative rows for each expected class, without hitting DB.
 *
 * No DB, no I/O. Runs via `node --import tsx --test`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToClassifyInput, type SessionRow } from './backfill-session-class';
import { classifySession } from './ingest/domain/session-class';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 'session-abc',
    model: 'claude-sonnet-4-5',
    project_id: 'local-Users-cherie-dev-myapp',
    project_cwd_hint: 'local:/Users/cherie/dev/myapp',
    title: 'Implement feature X',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. rowToClassifyInput: column → field mapping
// ---------------------------------------------------------------------------

describe('rowToClassifyInput — column mapping', () => {
  it('maps model correctly', () => {
    const r = row({ model: 'codex-auto-review' });
    assert.strictEqual(rowToClassifyInput(r).model, 'codex-auto-review');
  });

  it('maps null model correctly', () => {
    const r = row({ model: null });
    assert.strictEqual(rowToClassifyInput(r).model, null);
  });

  it('maps project_id → projectId', () => {
    const r = row({ project_id: 'local-Users-cherie-dev-lathe' });
    assert.strictEqual(rowToClassifyInput(r).projectId, 'local-Users-cherie-dev-lathe');
  });

  it('maps project_cwd_hint → projectCwdHint', () => {
    const r = row({ project_cwd_hint: '/Users/cherie/dev/Lathe/sandbox/run-1' });
    assert.strictEqual(
      rowToClassifyInput(r).projectCwdHint,
      '/Users/cherie/dev/Lathe/sandbox/run-1',
    );
  });

  it('maps null project_cwd_hint → null projectCwdHint', () => {
    const r = row({ project_cwd_hint: null });
    assert.strictEqual(rowToClassifyInput(r).projectCwdHint, null);
  });

  it('maps title correctly', () => {
    const r = row({ title: 'You are Lathe Chat: analyse sessions' });
    assert.strictEqual(rowToClassifyInput(r).title, 'You are Lathe Chat: analyse sessions');
  });

  it('output has exactly the four expected keys', () => {
    const result = rowToClassifyInput(row({}));
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['model', 'projectCwdHint', 'projectId', 'title']);
  });

  it('id column is NOT forwarded (not a classifySession input)', () => {
    const result = rowToClassifyInput(row({ id: 'should-not-appear' }));
    assert.ok(!('id' in result), 'id should not be in classifySession input');
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: row → classify → expected class (re-derivability proof)
// ---------------------------------------------------------------------------

describe('row → classifySession end-to-end (DB-free)', () => {
  it('codex-auto-review row → auto_review', () => {
    const r = row({ model: 'codex-auto-review' });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'auto_review');
  });

  it('<synthetic> row → synthetic', () => {
    const r = row({ model: '<synthetic>' });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'synthetic');
  });

  it('sandbox cwd row → sandbox', () => {
    const r = row({
      model: 'claude-sonnet-4-5',
      project_cwd_hint: '/Users/cherie/dev/Lathe/sandbox/smoke-test',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'sandbox');
  });

  it('harness-codex cwd row → sandbox', () => {
    const r = row({
      model: 'gpt-4o',
      project_cwd_hint: '/tmp/harness-codex-run-abc',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'sandbox');
  });

  it('lathe-internal-analyst title row → internal', () => {
    const r = row({ title: 'lathe-internal-analyst-v2' });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'internal');
  });

  it('You are Lathe Chat title row → internal', () => {
    const r = row({ title: 'You are Lathe Chat: summarise findings' });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'internal');
  });

  it('lathe project + 登録セッション数 title → internal', () => {
    const r = row({
      project_id: 'local-Users-cherie-dev-lathe',
      title: '登録セッション数を確認',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'internal');
  });

  it('lathe project + list_sessions title → internal', () => {
    const r = row({
      project_id: 'lathe-project',
      title: 'debug list_sessions MCP call',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'internal');
  });

  it('ordinary development row → development', () => {
    const r = row({});
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'development');
  });

  it('null model ordinary row → development', () => {
    const r = row({ model: null });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'development');
  });

  it('null cwd row → development (not sandbox)', () => {
    const r = row({ project_cwd_hint: null });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'development');
  });

  // Regression: local: real-dev paths must NOT become sandbox
  it('local: real-dev path → development (not sandbox)', () => {
    const r = row({ project_cwd_hint: 'local:/Users/cherie/dev/Sanpyou' });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'development');
  });

  it('non-lathe project + project-scoped title → development', () => {
    const r = row({
      project_id: 'other-project',
      title: '登録セッション数を確認',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'development');
  });

  // Priority: auto_review wins over sandbox cwd
  it('auto_review model + sandbox cwd → auto_review (rule priority)', () => {
    const r = row({
      model: 'codex-auto-review',
      project_cwd_hint: '/Users/cherie/dev/Lathe/sandbox/x',
    });
    assert.strictEqual(classifySession(rowToClassifyInput(r)), 'auto_review');
  });
});
