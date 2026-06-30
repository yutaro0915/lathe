/**
 * Unit tests for decideLock() and the import-main guard in ingest-incremental.ts.
 *
 * No I/O, no DB — purely in-memory / side-effect-free.
 *
 * Import-main guard: importing this module must NOT trigger main() / DB
 * connections / file I/O. The test itself proves this: if main() ran on
 * import, the test process would either hang on a DB connect or emit noisy
 * errors before any test assertion runs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decideLock } from './ingest-incremental';

// ---------------------------------------------------------------------------
// Import-main guard (smoke test)
// ---------------------------------------------------------------------------

test('import-main guard: importing ingest-incremental does not execute main()', () => {
  // If main() had run on import, the test process would have attempted a DB
  // connection (getDatabaseUrl → Pool constructor) and either hung or thrown
  // before reaching this assertion. Reaching here proves main() was NOT called.
  assert.ok(typeof decideLock === 'function', 'decideLock export is reachable after import');
});

const SELF_PID = 12345;
const OTHER_PID = 99999;

// ---------------------------------------------------------------------------
// Lock absent
// ---------------------------------------------------------------------------

test('decideLock: no lock file → acquire', () => {
  const result = decideLock({
    exists: false,
    holderPid: NaN,
    holderAlive: false,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'acquire');
});

// ---------------------------------------------------------------------------
// Lock held by another live process
// ---------------------------------------------------------------------------

test('decideLock: lock held by live other process → skip', () => {
  const result = decideLock({
    exists: true,
    holderPid: OTHER_PID,
    holderAlive: true,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'skip');
});

// ---------------------------------------------------------------------------
// Lock held by dead process (stale)
// ---------------------------------------------------------------------------

test('decideLock: lock held by dead other process → reclaim', () => {
  const result = decideLock({
    exists: true,
    holderPid: OTHER_PID,
    holderAlive: false,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'reclaim');
});

// ---------------------------------------------------------------------------
// Lock file exists but PID is unreadable (NaN)
// ---------------------------------------------------------------------------

test('decideLock: lock file exists with NaN PID (unreadable) → reclaim', () => {
  const result = decideLock({
    exists: true,
    holderPid: NaN,
    holderAlive: false,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'reclaim');
});

test('decideLock: lock file exists with NaN PID, holderAlive=true (impossible but safe) → reclaim', () => {
  // holderAlive can't be true for NaN pid in practice, but pure function should
  // ignore holderAlive when pid is NaN and treat as reclaim.
  const result = decideLock({
    exists: true,
    holderPid: NaN,
    holderAlive: true,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'reclaim');
});

// ---------------------------------------------------------------------------
// Lock held by self (same PID)
// ---------------------------------------------------------------------------

test('decideLock: lock held by self PID → acquire (re-entrant / restart safe)', () => {
  const result = decideLock({
    exists: true,
    holderPid: SELF_PID,
    holderAlive: true,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'acquire');
});

test('decideLock: lock held by self PID but marked dead → acquire', () => {
  // Even if holderAlive=false (shouldn't happen for self), self-PID check wins.
  const result = decideLock({
    exists: true,
    holderPid: SELF_PID,
    holderAlive: false,
    selfPid: SELF_PID,
  });
  assert.equal(result, 'acquire');
});
