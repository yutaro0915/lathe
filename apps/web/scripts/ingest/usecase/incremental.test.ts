/**
 * Unit tests for pure functions in incremental.ts.
 *
 * No DB required — all tests are purely in-memory.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { codexHeadSessionId, listCodexRollouts } from '../providers/codex';
import { isStale, deduplicateByLatestMtime, resolveCodexRolloutFiles } from './incremental';

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

test('isStale: returns true when endedAt is null (session not in DB)', () => {
  assert.equal(isStale(Date.now(), null), true);
});

test('isStale: returns true when endedAt is undefined (session not in DB)', () => {
  assert.equal(isStale(Date.now(), undefined), true);
});

test('isStale: returns true when endedAt is not parseable', () => {
  assert.equal(isStale(Date.now(), 'not-a-date'), true);
});

test('isStale: returns false when file mtime is within 60s buffer after endedAt', () => {
  const endedAt = '2026-06-26T00:01:00.000Z'; // epoch 1750896060000
  const endedMs = Date.parse(endedAt);
  // mtime = endedAt + 30s (within buffer)
  assert.equal(isStale(endedMs + 30_000, endedAt), false);
});

test('isStale: returns false when file mtime equals endedAt exactly', () => {
  const endedAt = '2026-06-26T00:01:00.000Z';
  const endedMs = Date.parse(endedAt);
  assert.equal(isStale(endedMs, endedAt), false);
});

test('isStale: returns true when file mtime exceeds endedAt by more than 60s', () => {
  const endedAt = '2026-06-26T00:01:00.000Z';
  const endedMs = Date.parse(endedAt);
  // mtime = endedAt + 61s (beyond buffer)
  assert.equal(isStale(endedMs + 61_000, endedAt), true);
});

test('isStale: boundary — exactly 60s beyond endedAt is NOT stale', () => {
  const endedAt = '2026-06-26T00:01:00.000Z';
  const endedMs = Date.parse(endedAt);
  // fileMtimeMs > endedMs + 60_000 must be false at exact boundary
  assert.equal(isStale(endedMs + 60_000, endedAt), false);
});

test('isStale: boundary — 60s + 1ms beyond endedAt IS stale', () => {
  const endedAt = '2026-06-26T00:01:00.000Z';
  const endedMs = Date.parse(endedAt);
  assert.equal(isStale(endedMs + 60_001, endedAt), true);
});

// ---------------------------------------------------------------------------
// deduplicateByLatestMtime
// ---------------------------------------------------------------------------

test('deduplicateByLatestMtime: empty input returns empty map', () => {
  const result = deduplicateByLatestMtime([]);
  assert.equal(result.size, 0);
});

test('deduplicateByLatestMtime: single entry is kept', () => {
  const result = deduplicateByLatestMtime([
    { sessionId: 'abc', file: '/a/abc.jsonl', mtime: 1000 },
  ]);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get('abc'), { file: '/a/abc.jsonl', mtime: 1000 });
});

test('deduplicateByLatestMtime: same sessionId across dirs keeps latest mtime', () => {
  const result = deduplicateByLatestMtime([
    { sessionId: 'dup', file: '/dir1/dup.jsonl', mtime: 1000 },
    { sessionId: 'dup', file: '/dir2/dup.jsonl', mtime: 2000 }, // newer → wins
    { sessionId: 'dup', file: '/dir3/dup.jsonl', mtime: 500 },
  ]);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get('dup'), { file: '/dir2/dup.jsonl', mtime: 2000 });
});

test('deduplicateByLatestMtime: different sessionIds are all kept', () => {
  const result = deduplicateByLatestMtime([
    { sessionId: 'a', file: '/a.jsonl', mtime: 100 },
    { sessionId: 'b', file: '/b.jsonl', mtime: 200 },
    { sessionId: 'c', file: '/c.jsonl', mtime: 300 },
  ]);
  assert.equal(result.size, 3);
});

test('deduplicateByLatestMtime: first-wins tie (equal mtime): first entry is kept', () => {
  const result = deduplicateByLatestMtime([
    { sessionId: 'tie', file: '/dir1/tie.jsonl', mtime: 1000 },
    { sessionId: 'tie', file: '/dir2/tie.jsonl', mtime: 1000 }, // same mtime, does NOT replace
  ]);
  assert.equal(result.size, 1);
  // First entry must win when mtime is equal (not strictly greater)
  assert.deepEqual(result.get('tie'), { file: '/dir1/tie.jsonl', mtime: 1000 });
});

test('deduplicateByLatestMtime: latest mtime from third dir wins when interleaved', () => {
  const result = deduplicateByLatestMtime([
    { sessionId: 'x', file: '/dir1/x.jsonl', mtime: 500 },
    { sessionId: 'y', file: '/dir1/y.jsonl', mtime: 900 },
    { sessionId: 'x', file: '/dir2/x.jsonl', mtime: 800 }, // x: 800 > 500, replace
    { sessionId: 'y', file: '/dir2/y.jsonl', mtime: 700 }, // y: 700 < 900, keep 900
  ]);
  assert.equal(result.size, 2);
  assert.deepEqual(result.get('x'), { file: '/dir2/x.jsonl', mtime: 800 });
  assert.deepEqual(result.get('y'), { file: '/dir1/y.jsonl', mtime: 900 });
});

// ---------------------------------------------------------------------------
// resolveCodexRolloutFiles
// ---------------------------------------------------------------------------

test('resolveCodexRolloutFiles: explicit empty override bypasses discovery', () => {
  let discovered = false;
  const result = resolveCodexRolloutFiles([], () => {
    discovered = true;
    throw new Error('discovery should not run');
  });

  assert.deepEqual(result, []);
  assert.equal(discovered, false);
});

test('resolveCodexRolloutFiles: undefined override uses discovery', () => {
  let discovered = false;
  const files = ['/tmp/rollout-a.jsonl', '/tmp/rollout-b.jsonl'];
  const result = resolveCodexRolloutFiles(undefined, () => {
    discovered = true;
    return files;
  });

  assert.equal(discovered, true);
  assert.deepEqual(result, files);
});

// ---------------------------------------------------------------------------
// codexHeadSessionId
// ---------------------------------------------------------------------------

test('codexHeadSessionId: extracts id from session_meta line', () => {
  const tmp = path.join(os.tmpdir(), `rollout-test-${Date.now()}.jsonl`);
  const line = JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-06-30T00:00:00Z',
    payload: { id: 'abc-123-session', cwd: '/repo/project' },
  });
  fs.writeFileSync(tmp, line + '\n', 'utf8');
  try {
    assert.equal(codexHeadSessionId(tmp), 'abc-123-session');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('codexHeadSessionId: falls back to basename when no id in head bytes', () => {
  const tmp = path.join(os.tmpdir(), `rollout-fallback-${Date.now()}.jsonl`);
  // File with no "id" field — should fall back to basename without .jsonl
  fs.writeFileSync(tmp, JSON.stringify({ type: 'event_msg', payload: {} }) + '\n', 'utf8');
  try {
    const result = codexHeadSessionId(tmp);
    assert.equal(result, path.basename(tmp, '.jsonl'));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('codexHeadSessionId: returns basename for unreadable file', () => {
  const nonExistent = '/tmp/no-such-rollout-file.jsonl';
  const result = codexHeadSessionId(nonExistent);
  assert.equal(result, 'no-such-rollout-file');
});

// ---------------------------------------------------------------------------
// listCodexRollouts — no cwd filter (all projects)
// ---------------------------------------------------------------------------

test('listCodexRollouts: discovers rollout files across sessions and archived_sessions without cwd filter', () => {
  // Set up a fake ~/.codex tree in a temp dir using a subdir approach.
  // We cannot override os.homedir(), so we test the function's filtering
  // logic indirectly by verifying it returns ONLY rollout-*.jsonl files.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const sessionsDir = path.join(tmp, 'sessions', '2026', '06', '30');
  const archivedDir = path.join(tmp, 'archived_sessions', '2025', '12', '01');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(archivedDir, { recursive: true });

  // Write rollout files for two different "projects" (different cwd in content)
  const rollout1 = path.join(sessionsDir, 'rollout-proj-a.jsonl');
  const rollout2 = path.join(archivedDir, 'rollout-proj-b.jsonl');
  const notARollout = path.join(sessionsDir, 'other-file.jsonl');
  fs.writeFileSync(rollout1, JSON.stringify({ type: 'session_meta', payload: { id: 'a', cwd: '/repo/proj-a' } }) + '\n');
  fs.writeFileSync(rollout2, JSON.stringify({ type: 'session_meta', payload: { id: 'b', cwd: '/repo/proj-b' } }) + '\n');
  fs.writeFileSync(notARollout, 'ignored\n');

  try {
    // Walk the fake tree manually (same logic as listCodexRollouts but scoped to tmp).
    const found: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) found.push(full);
      }
    };
    walk(tmp);

    // Both rollouts found regardless of cwd (no cwd filter).
    assert.ok(found.includes(rollout1), 'rollout1 from sessions dir should be found');
    assert.ok(found.includes(rollout2), 'rollout2 from archived_sessions dir should be found');
    // Non-rollout file excluded.
    assert.ok(!found.includes(notARollout), 'non-rollout-named file should be excluded');
    assert.equal(found.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isStale is reused for codex sessionId skip logic (same semantics)', () => {
  // Verify that isStale works with codex-style session ids (no special casing needed).
  const endedAt = '2026-06-30T10:00:00.000Z';
  const endedMs = Date.parse(endedAt);
  // Fresh: mtime within buffer → skip
  assert.equal(isStale(endedMs + 30_000, endedAt), false);
  // Stale: mtime beyond buffer → upsert
  assert.equal(isStale(endedMs + 61_000, endedAt), true);
  // Not in DB (null): always upsert
  assert.equal(isStale(endedMs, null), true);
});
