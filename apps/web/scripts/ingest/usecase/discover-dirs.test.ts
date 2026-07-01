/**
 * Unit tests for pure functions in discover-dirs.ts.
 *
 * No filesystem access required — all tests are purely in-memory.
 *
 * NOTE (ADR 0012 §4, mark-don't-delete): 'lathe-internal' dirs are no longer
 * excluded at the discover stage. They are ingested and classifySession assigns
 * them session_class='internal'. isExcludedDirName always returns false.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isExcludedDirName } from './discover-dirs';

// ---------------------------------------------------------------------------
// isExcludedDirName — always returns false (mark-don't-delete policy)
// ---------------------------------------------------------------------------

test('isExcludedDirName: lathe-internal dirs are NOT excluded (mark-don\'t-delete)', () => {
  assert.equal(isExcludedDirName('lathe-internal'), false);
});

test('isExcludedDirName: lathe-internal substring is NOT excluded', () => {
  assert.equal(isExcludedDirName('Users-cherie-LLMWiki-lathe-internal'), false);
});

test('isExcludedDirName: lathe-internal suffix is NOT excluded', () => {
  assert.equal(isExcludedDirName('my-project-lathe-internal'), false);
});

test('isExcludedDirName: does not exclude normal project dirs', () => {
  assert.equal(isExcludedDirName('Users-cherie-LLMWiki-projects-lathe'), false);
});

test('isExcludedDirName: does not exclude dirs named "lathe" alone', () => {
  assert.equal(isExcludedDirName('lathe'), false);
});

test('isExcludedDirName: does not exclude empty string', () => {
  assert.equal(isExcludedDirName(''), false);
});

test('isExcludedDirName: does not exclude partial match dirs', () => {
  assert.equal(isExcludedDirName('lathe-intern'), false);
  assert.equal(isExcludedDirName('internal-lathe'), false);
});

test('isExcludedDirName: does not exclude mixed-case dirs', () => {
  assert.equal(isExcludedDirName('Lathe-Internal'), false);
  assert.equal(isExcludedDirName('LATHE-INTERNAL'), false);
});
