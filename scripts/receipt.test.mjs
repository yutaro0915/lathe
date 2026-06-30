import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, buildReceiptPath, buildReceiptJson } from './receipt.mjs';

// validateArgs — step validation
test('validateArgs: review + PASS → ok', () => {
  const r = validateArgs('review', 'abc', 'PASS');
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
});

test('validateArgs: verify + GREEN → ok', () => {
  const r = validateArgs('verify', 'abc', 'GREEN');
  assert.equal(r.ok, true);
});

test('validateArgs: unknown step → error', () => {
  const r = validateArgs('unknown', 'abc', 'PASS');
  assert.equal(r.ok, false);
  assert.ok(r.error, 'should have error message');
});

test('validateArgs: empty sha → error', () => {
  const r = validateArgs('review', '', 'PASS');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('validateArgs: review with GREEN verdict → error', () => {
  const r = validateArgs('review', 'abc', 'GREEN');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('validateArgs: verify with PASS verdict → error', () => {
  const r = validateArgs('verify', 'abc', 'PASS');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('validateArgs: review + CHANGES → ok', () => {
  const r = validateArgs('review', 'abc', 'CHANGES');
  assert.equal(r.ok, true);
});

test('validateArgs: verify + RED → ok', () => {
  const r = validateArgs('verify', 'abc', 'RED');
  assert.equal(r.ok, true);
});

// buildReceiptPath — now takes receiptsDir directly (not repoRoot)
// receiptsDir is supplied by resolveReceiptsDir() in real usage (common-dir based)
test('buildReceiptPath returns correct absolute path for receiptsDir', () => {
  const p = buildReceiptPath('/path/to/.git/lathe-receipts', 'abc123', 'review');
  assert.equal(p, '/path/to/.git/lathe-receipts/abc123.review.json');
});

test('buildReceiptPath verify step', () => {
  const p = buildReceiptPath('/path/to/.git/lathe-receipts', 'def456', 'verify');
  assert.equal(p, '/path/to/.git/lathe-receipts/def456.verify.json');
});

// buildReceiptJson
test('buildReceiptJson returns correct object', () => {
  const ts = '2024-01-01T00:00:00.000Z';
  const obj = buildReceiptJson('review', 'abc', 'PASS', 'reviewer', ts);
  assert.deepEqual(obj, {
    step: 'review',
    sha: 'abc',
    verdict: 'PASS',
    ts,
    agent: 'reviewer',
  });
});

test('buildReceiptJson verify variant', () => {
  const ts = '2024-06-01T12:00:00.000Z';
  const obj = buildReceiptJson('verify', 'xyz789', 'GREEN', 'verifier', ts);
  assert.equal(obj.step, 'verify');
  assert.equal(obj.verdict, 'GREEN');
  assert.equal(obj.sha, 'xyz789');
  assert.equal(obj.agent, 'verifier');
  assert.equal(obj.ts, ts);
});
