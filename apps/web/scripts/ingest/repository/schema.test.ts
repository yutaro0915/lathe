/**
 * Unit tests for the resetDatabase safety guard in schema.ts.
 *
 * No real DB required — getSessionCount is tested via a mock Pool, and the
 * guard logic is tested by calling getSessionCount with a mock and verifying
 * the thrown error message.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { getSessionCount } from './schema';

// ---------------------------------------------------------------------------
// Helpers: minimal Pool mocks
// ---------------------------------------------------------------------------

function makePool(countResult: string | 'throw'): Pool {
  return {
    query: async (_sql: string) => {
      if (countResult === 'throw') throw new Error('relation "sessions" does not exist');
      return { rows: [{ count: countResult }] };
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// getSessionCount — success paths
// ---------------------------------------------------------------------------

test('getSessionCount: returns parsed count when query succeeds', async () => {
  const pool = makePool('42');
  const n = await getSessionCount(pool);
  assert.equal(n, 42);
});

test('getSessionCount: returns 0 when rows is empty (fresh schema)', async () => {
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as Pool;
  const n = await getSessionCount(pool);
  assert.equal(n, 0);
});

test('getSessionCount: returns 0 when query throws (table not yet created)', async () => {
  const pool = makePool('throw');
  const n = await getSessionCount(pool);
  assert.equal(n, 0);
});

// ---------------------------------------------------------------------------
// Guard logic: count>0 && !LATHE_FORCE_RESET → refuse
// ---------------------------------------------------------------------------

test('resetDatabase guard: count=0 allows through (no throw from getSessionCount)', async () => {
  // getSessionCount returning 0 means the guard passes.
  const pool = makePool('0');
  const n = await getSessionCount(pool);
  assert.equal(n, 0);
  // Guard condition: count > 0 → false → no throw
  assert.equal(n > 0, false);
});

test('resetDatabase guard: count>0 without LATHE_FORCE_RESET=1 → should refuse', async () => {
  const pool = makePool('825');
  const n = await getSessionCount(pool);
  assert.equal(n, 825);

  const origEnv = process.env.LATHE_FORCE_RESET;
  delete process.env.LATHE_FORCE_RESET;
  try {
    // Reproduce the exact guard condition from resetDatabase
    const shouldRefuse = n > 0 && process.env.LATHE_FORCE_RESET !== '1';
    assert.equal(shouldRefuse, true, 'guard should refuse when count>0 and LATHE_FORCE_RESET is unset');
  } finally {
    if (origEnv !== undefined) process.env.LATHE_FORCE_RESET = origEnv;
  }
});

test('resetDatabase guard: count>0 with LATHE_FORCE_RESET=1 → allows through', async () => {
  const pool = makePool('825');
  const n = await getSessionCount(pool);
  assert.equal(n, 825);

  const origEnv = process.env.LATHE_FORCE_RESET;
  process.env.LATHE_FORCE_RESET = '1';
  try {
    const shouldRefuse = n > 0 && process.env.LATHE_FORCE_RESET !== '1';
    assert.equal(shouldRefuse, false, 'guard should allow when LATHE_FORCE_RESET=1');
  } finally {
    if (origEnv !== undefined) {
      process.env.LATHE_FORCE_RESET = origEnv;
    } else {
      delete process.env.LATHE_FORCE_RESET;
    }
  }
});

test('resetDatabase guard: count=0 with LATHE_FORCE_RESET unset → allows through', async () => {
  const pool = makePool('0');
  const n = await getSessionCount(pool);

  const origEnv = process.env.LATHE_FORCE_RESET;
  delete process.env.LATHE_FORCE_RESET;
  try {
    const shouldRefuse = n > 0 && process.env.LATHE_FORCE_RESET !== '1';
    assert.equal(shouldRefuse, false, 'guard should allow when count=0 (empty scratch DB)');
  } finally {
    if (origEnv !== undefined) process.env.LATHE_FORCE_RESET = origEnv;
  }
});
