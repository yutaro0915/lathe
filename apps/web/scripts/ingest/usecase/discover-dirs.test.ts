/**
 * Unit tests for pure functions in discover-dirs.ts.
 *
 * No filesystem access required — all tests are purely in-memory.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isExcludedDirName } from './discover-dirs';

// ---------------------------------------------------------------------------
// isExcludedDirName
// ---------------------------------------------------------------------------

test('isExcludedDirName: excludes dirs that contain "lathe-internal"', () => {
  assert.equal(isExcludedDirName('lathe-internal'), true);
});

test('isExcludedDirName: excludes dirs with "lathe-internal" as a substring', () => {
  assert.equal(isExcludedDirName('Users-cherie-LLMWiki-lathe-internal'), true);
});

test('isExcludedDirName: excludes dirs with "lathe-internal" suffix', () => {
  assert.equal(isExcludedDirName('my-project-lathe-internal'), true);
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

test('isExcludedDirName: does not exclude dirs that only partially match', () => {
  assert.equal(isExcludedDirName('lathe-intern'), false);
  assert.equal(isExcludedDirName('internal-lathe'), false);
});

test('isExcludedDirName: case-sensitive — mixed case is not excluded', () => {
  assert.equal(isExcludedDirName('Lathe-Internal'), false);
  assert.equal(isExcludedDirName('LATHE-INTERNAL'), false);
});
