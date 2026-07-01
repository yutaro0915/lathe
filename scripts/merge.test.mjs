import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReceipts, parseRevList, extractFirstCommitMessage } from './merge.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// parseRevList
test('parseRevList: normal multi-line output', () => {
  const result = parseRevList('abc\ndef\nghi');
  assert.deepEqual(result, ['abc', 'def', 'ghi']);
});

test('parseRevList: empty string → []', () => {
  const result = parseRevList('');
  assert.deepEqual(result, []);
});

test('parseRevList: trims and filters blank lines', () => {
  const result = parseRevList('  \n abc \n ');
  assert.deepEqual(result, ['abc']);
});

test('parseRevList: single sha, no trailing newline', () => {
  const result = parseRevList('abc123');
  assert.deepEqual(result, ['abc123']);
});

// Helper: create a temp receipts dir for a test
function makeTempReceipts(testId) {
  const dir = join(tmpdir(), `lathe-merge-test-${testId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeReceipt(dir, sha, step, verdict) {
  const content = JSON.stringify({ step, sha, verdict, ts: new Date().toISOString(), agent: 'test' });
  writeFileSync(join(dir, `${sha}.${step}.json`), content, 'utf8');
}

// checkReceipts — receipt unit is the branch tip sha (HEAD), not a list.
// reviewer/verifier assess the full branch diff, so receipts are issued at HEAD.

// checkReceipts — happy path
test('checkReceipts: both receipts present for head sha → ok', () => {
  const dir = makeTempReceipts('both');
  writeReceipt(dir, 'headsha1', 'review', 'PASS');
  writeReceipt(dir, 'headsha1', 'verify', 'GREEN');
  const result = checkReceipts(dir, 'headsha1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  rmSync(dir, { recursive: true, force: true });
});

// checkReceipts — review missing
test('checkReceipts: review receipt missing for head sha → not ok', () => {
  const dir = makeTempReceipts('rev-missing');
  writeReceipt(dir, 'headsha2', 'verify', 'GREEN');
  const result = checkReceipts(dir, 'headsha2');
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.sha === 'headsha2' && m.step === 'review'));
  rmSync(dir, { recursive: true, force: true });
});

// checkReceipts — verify missing
test('checkReceipts: verify receipt missing for head sha → not ok', () => {
  const dir = makeTempReceipts('ver-missing');
  writeReceipt(dir, 'headsha3', 'review', 'PASS');
  const result = checkReceipts(dir, 'headsha3');
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.sha === 'headsha3' && m.step === 'verify'));
  rmSync(dir, { recursive: true, force: true });
});

// checkReceipts — review verdict is CHANGES (not PASS)
test('checkReceipts: review verdict CHANGES for head sha → not ok', () => {
  const dir = makeTempReceipts('rev-changes');
  writeReceipt(dir, 'headsha4', 'review', 'CHANGES');
  writeReceipt(dir, 'headsha4', 'verify', 'GREEN');
  const result = checkReceipts(dir, 'headsha4');
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.sha === 'headsha4' && m.step === 'review'));
  rmSync(dir, { recursive: true, force: true });
});

// checkReceipts — verify verdict is RED (not GREEN)
test('checkReceipts: verify verdict RED for head sha → not ok', () => {
  const dir = makeTempReceipts('ver-red');
  writeReceipt(dir, 'headsha5', 'review', 'PASS');
  writeReceipt(dir, 'headsha5', 'verify', 'RED');
  const result = checkReceipts(dir, 'headsha5');
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.sha === 'headsha5' && m.step === 'verify'));
  rmSync(dir, { recursive: true, force: true });
});

// checkReceipts — both missing
test('checkReceipts: both receipts missing for head sha → not ok, lists both', () => {
  const dir = makeTempReceipts('both-missing');
  const result = checkReceipts(dir, 'headsha6');
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.sha === 'headsha6' && m.step === 'review'));
  assert.ok(result.missing.some((m) => m.sha === 'headsha6' && m.step === 'verify'));
  rmSync(dir, { recursive: true, force: true });
});

// extractFirstCommitMessage — squash commit message extraction
// Input format: git log --reverse --format=%B%x00 (NUL-separated commit bodies)
test('extractFirstCommitMessage: single commit → returns its full message', () => {
  // Single commit: body + NUL + trailing empty
  const log = 'feat(workflow): add squash merge\n\nBody line.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\0';
  const result = extractFirstCommitMessage(log);
  assert.equal(result, 'feat(workflow): add squash merge\n\nBody line.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>');
});

test('extractFirstCommitMessage: two commits → returns first commit message only', () => {
  // Two commits: first body + NUL + second body + NUL + trailing empty
  const log = 'feat(workflow): add squash merge\n\nBody of first commit.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\0fix(workflow): review fix\n\nBody of second commit.\n\0';
  const result = extractFirstCommitMessage(log);
  assert.equal(result, 'feat(workflow): add squash merge\n\nBody of first commit.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>');
});

test('extractFirstCommitMessage: three commits → returns first commit message only', () => {
  const log = 'feat(foo): implement foo\n\nDetails here.\n\nCo-Authored-By: Claude <x>\n\0fix(foo): review fix 1\n\nAnother body.\n\0fix(foo): review fix 2\n\n\0';
  const result = extractFirstCommitMessage(log);
  assert.equal(result, 'feat(foo): implement foo\n\nDetails here.\n\nCo-Authored-By: Claude <x>');
});

test('extractFirstCommitMessage: no body (subject only) → returns subject', () => {
  // Subject-only commit: git log emits subject + \n\n as the body for %B
  const log = 'feat(bar): add bar\n\n\0';
  const result = extractFirstCommitMessage(log);
  assert.equal(result, 'feat(bar): add bar');
});
