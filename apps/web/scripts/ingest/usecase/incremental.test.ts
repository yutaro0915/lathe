/**
 * Unit tests for pure functions in incremental.ts.
 *
 * No DB required — all tests are purely in-memory.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isStale, deduplicateByLatestMtime } from './incremental';

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
