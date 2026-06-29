/**
 * Unit tests for resolveNextBin() in dev-with-ingest-helpers.ts.
 *
 * No I/O — existsSync is injected so the function is purely deterministic.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveNextBin } from './dev-with-ingest-helpers.mjs';

const WEB_ROOT = '/fake/apps/web';

// ---------------------------------------------------------------------------
// Binary present
// ---------------------------------------------------------------------------

test('resolveNextBin: binary present → ok:true with correct path', () => {
  const result = resolveNextBin(WEB_ROOT, () => true);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.path.endsWith('/node_modules/.bin/next'), `path should end with node_modules/.bin/next, got: ${result.path}`);
    assert.ok(result.path.startsWith(WEB_ROOT), `path should start with webRoot`);
  }
});

// ---------------------------------------------------------------------------
// Binary missing
// ---------------------------------------------------------------------------

test('resolveNextBin: binary missing → ok:false with reason', () => {
  const result = resolveNextBin(WEB_ROOT, () => false);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reason.includes('next binary not found'), `reason should mention binary not found, got: ${result.reason}`);
    assert.ok(result.reason.includes('pnpm install'), `reason should suggest pnpm install, got: ${result.reason}`);
  }
});

// ---------------------------------------------------------------------------
// existsFn called with correct path
// ---------------------------------------------------------------------------

test('resolveNextBin: passes the resolved path to existsFn', () => {
  let capturedPath = '';
  resolveNextBin(WEB_ROOT, (p) => {
    capturedPath = p;
    return false;
  });
  assert.ok(capturedPath.includes('node_modules'), `existsFn should be called with node_modules path`);
  assert.ok(capturedPath.endsWith('next'), `existsFn should be called with next binary path`);
});
