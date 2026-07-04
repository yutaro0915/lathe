import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDiffRange, ZERO_SHA } from './ci-changed-paths.mjs';

// --- pull_request events ---

test('deriveDiffRange: pull_request with valid base/head → range', () => {
  const payload = {
    pull_request: {
      base: { sha: 'base000000000000000000000000000000000000' },
      head: { sha: 'head000000000000000000000000000000000000' },
    },
  };
  const result = deriveDiffRange('pull_request', payload);
  assert.deepEqual(result, {
    base: 'base000000000000000000000000000000000000',
    head: 'head000000000000000000000000000000000000',
  });
});

test('deriveDiffRange: pull_request missing head sha → null', () => {
  const payload = {
    pull_request: {
      base: { sha: 'base000000000000000000000000000000000000' },
      head: {},
    },
  };
  assert.equal(deriveDiffRange('pull_request', payload), null);
});

test('deriveDiffRange: pull_request missing base sha → null', () => {
  const payload = {
    pull_request: {
      base: {},
      head: { sha: 'head000000000000000000000000000000000000' },
    },
  };
  assert.equal(deriveDiffRange('pull_request', payload), null);
});

test('deriveDiffRange: pull_request missing pull_request key → null', () => {
  assert.equal(deriveDiffRange('pull_request', {}), null);
});

// --- push events ---

test('deriveDiffRange: push with non-zero before/after → real diff range', () => {
  const before = 'aaaa0000000000000000000000000000000000000';
  const after = 'bbbb0000000000000000000000000000000000000';
  const result = deriveDiffRange('push', { before, after });
  assert.deepEqual(result, { base: before, head: after });
});

test('deriveDiffRange: push with zero before (new branch) → merge-base sentinel', () => {
  const after = 'cccc0000000000000000000000000000000000000';
  const result = deriveDiffRange('push', { before: ZERO_SHA, after });
  assert.deepEqual(result, { base: '__merge-base-main__', head: after });
});

test('deriveDiffRange: push without before → merge-base sentinel', () => {
  const after = 'dddd0000000000000000000000000000000000000';
  const result = deriveDiffRange('push', { after });
  assert.deepEqual(result, { base: '__merge-base-main__', head: after });
});

test('deriveDiffRange: push missing after → null', () => {
  const result = deriveDiffRange('push', { before: 'aaaa0000000000000000000000000000000000000' });
  assert.equal(result, null);
});

// AC #4 — no-op falsification: same before/after on push still produces a range
// (the actual diff will be empty from git, but deriveDiffRange does not collapse to null).
// This is correct: git diff before..after returns empty when before==after — skip is appropriate.
test('deriveDiffRange: push where before === after → returns range (non-null, git will emit empty diff)', () => {
  const sha = 'aaaa0000000000000000000000000000000000000';
  const result = deriveDiffRange('push', { before: sha, after: sha });
  // Not null — the git diff resolves to empty, which is the correct semantics
  assert.ok(result !== null, 'should return a range (not null)');
  assert.equal(result.base, sha);
  assert.equal(result.head, sha);
});

// --- unsupported events ---

test('deriveDiffRange: unknown event → null', () => {
  assert.equal(deriveDiffRange('schedule', {}), null);
});

test('deriveDiffRange: null payload → null', () => {
  assert.equal(deriveDiffRange('push', null), null);
});

test('deriveDiffRange: non-object payload → null', () => {
  assert.equal(deriveDiffRange('push', 'bad'), null);
});

// AC #4 — key invariant: push event with real before..after gives non-null range
// (contrast with old `git diff origin/main...HEAD` which was empty after same-SHA push to main)
test('deriveDiffRange: push with distinct before/after is always non-null (no-op impossibility proof)', () => {
  const before = 'old0000000000000000000000000000000000000a';
  const after = 'new0000000000000000000000000000000000000b';
  const result = deriveDiffRange('push', { before, after });
  assert.ok(result !== null, 'push with distinct shas must produce a range');
  assert.equal(result.base, before);
  assert.equal(result.head, after);
});
