import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReceipts, parseRevList, extractFirstCommitMessage, cleanupFailedSquash, decideLock, splitCommitMessage, buildPrCreateArgs, buildPrMergeArgs, buildPrChecksWatchArgs, buildPrMergeFallbackArgs } from './merge.mjs';
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

// landing lock decision logic
const SELF_PID = 12345;
const OTHER_PID = 99999;

test('decideLock: no lock file -> acquire', () => {
  assert.equal(decideLock({
    exists: false,
    holderPid: NaN,
    holderAlive: false,
    selfPid: SELF_PID,
  }), 'acquire');
});

test('decideLock: live other holder -> skip', () => {
  assert.equal(decideLock({
    exists: true,
    holderPid: OTHER_PID,
    holderAlive: true,
    selfPid: SELF_PID,
  }), 'skip');
});

test('decideLock: dead other holder -> reclaim', () => {
  assert.equal(decideLock({
    exists: true,
    holderPid: OTHER_PID,
    holderAlive: false,
    selfPid: SELF_PID,
  }), 'reclaim');
});

test('decideLock: unreadable PID -> reclaim', () => {
  assert.equal(decideLock({
    exists: true,
    holderPid: NaN,
    holderAlive: false,
    selfPid: SELF_PID,
  }), 'reclaim');
});

test('decideLock: zero PID -> reclaim even if holderAlive is true', () => {
  assert.equal(decideLock({
    exists: true,
    holderPid: 0,
    holderAlive: true,
    selfPid: SELF_PID,
  }), 'reclaim');
});

test('decideLock: self PID -> acquire', () => {
  assert.equal(decideLock({
    exists: true,
    holderPid: SELF_PID,
    holderAlive: true,
    selfPid: SELF_PID,
  }), 'acquire');
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

// cleanupFailedSquash — hermetic temp git repo smoke test
test('cleanupFailedSquash: squash 衝突後に working tree がクリーンになること', async () => {
  const { mkdtempSync, writeFileSync: wfs, readFileSync: rfs } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');

  const tmp = mkdtempSync(join(tmpdir(), 'lathe-squash-smoke-'));
  try {
    // temp repo 初期化
    const git = (args) =>
      execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);

    // main に base commit
    wfs(join(tmp, 'f.txt'), 'base\n', 'utf8');
    git(['add', 'f.txt']);
    git(['commit', '-m', 'base']);

    // feat ブランチで変更
    git(['checkout', '-b', 'feat']);
    wfs(join(tmp, 'f.txt'), 'feat\n', 'utf8');
    git(['add', 'f.txt']);
    git(['commit', '-m', 'feat: change']);

    // main に戻り競合する変更
    git(['checkout', 'main']);
    wfs(join(tmp, 'f.txt'), 'main\n', 'utf8');
    git(['add', 'f.txt']);
    git(['commit', '-m', 'main: change']);

    // squash マージを試みる（衝突を期待）
    let squashFailed = false;
    try {
      git(['merge', '--squash', 'feat']);
    } catch {
      squashFailed = true;
    }
    assert.ok(squashFailed, 'squash merge should fail with conflict');

    // sanity: 衝突状態で tree が dirty であること
    const statusBefore = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.ok(statusBefore.trim().length > 0, 'working tree should be dirty after squash conflict');

    // cleanupFailedSquash を呼ぶ
    cleanupFailedSquash(tmp);

    // 主張: tree がクリーンであること
    const statusAfter = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(statusAfter.trim(), '', 'working tree should be clean after cleanupFailedSquash');

    // f.txt に conflict marker が残っていないこと
    const content = rfs(join(tmp, 'f.txt'), 'utf8');
    assert.ok(!content.includes('<<<<<<<'), 'f.txt should not contain conflict markers after cleanup');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- splitCommitMessage ---

test('splitCommitMessage: subject + body → splits correctly', () => {
  const msg = 'feat(ci): add PR-based landing\n\nSwitches to gh pr create + auto-merge.\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  const { subject, body } = splitCommitMessage(msg);
  assert.equal(subject, 'feat(ci): add PR-based landing');
  assert.equal(body, 'Switches to gh pr create + auto-merge.\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
});

test('splitCommitMessage: subject only → body falls back to subject', () => {
  const msg = 'feat(ci): subject only';
  const { subject, body } = splitCommitMessage(msg);
  assert.equal(subject, 'feat(ci): subject only');
  assert.equal(body, 'feat(ci): subject only');
});

test('splitCommitMessage: empty string → empty subject, body falls back to subject', () => {
  const { subject, body } = splitCommitMessage('');
  assert.equal(subject, '');
  assert.equal(body, '');
});

test('splitCommitMessage: trims subject line', () => {
  const { subject } = splitCommitMessage('  feat: trimmed  \n\nbody text');
  assert.equal(subject, 'feat: trimmed');
});

// --- buildPrCreateArgs ---

test('buildPrCreateArgs: returns correct gh argv', () => {
  const args = buildPrCreateArgs({
    base: 'main',
    head: 'inner/task-15',
    title: 'feat(ci): PR-based landing',
    body: 'Body text here.',
  });
  assert.deepEqual(args, [
    'pr', 'create',
    '--base', 'main',
    '--head', 'inner/task-15',
    '--title', 'feat(ci): PR-based landing',
    '--body', 'Body text here.',
  ]);
});

test('buildPrCreateArgs: multi-line body is preserved as-is (no shell escaping needed for spawnSync)', () => {
  const body = 'Line one.\n\nLine two.';
  const args = buildPrCreateArgs({ base: 'main', head: 'feat', title: 'feat: x', body });
  assert.equal(args[args.indexOf('--body') + 1], body);
});

// AC #2 verification: git merge --squash no longer appears in buildPrCreateArgs / buildPrMergeArgs output
test('buildPrCreateArgs: does not include squash merge git args', () => {
  const args = buildPrCreateArgs({ base: 'main', head: 'feat', title: 't', body: 'b' });
  assert.ok(!args.includes('merge'), 'should not contain "merge" git sub-command');
  assert.ok(!args.includes('--squash') || args[0] !== 'git', 'should not be a local git squash call');
});

// --- buildPrMergeArgs ---

test('buildPrMergeArgs: returns correct gh argv', () => {
  const args = buildPrMergeArgs({ branch: 'inner/task-15' });
  assert.deepEqual(args, [
    'pr', 'merge', 'inner/task-15',
    '--auto', '--squash', '--delete-branch',
  ]);
});

test('buildPrMergeArgs: --auto flag is present (ensures CI gate controls landing)', () => {
  const args = buildPrMergeArgs({ branch: 'feat/foo' });
  assert.ok(args.includes('--auto'), '--auto must be present');
});

test('buildPrMergeArgs: --squash flag is present', () => {
  const args = buildPrMergeArgs({ branch: 'feat/foo' });
  assert.ok(args.includes('--squash'), '--squash must be present');
});

test('buildPrMergeArgs: --delete-branch flag is present', () => {
  const args = buildPrMergeArgs({ branch: 'feat/foo' });
  assert.ok(args.includes('--delete-branch'), '--delete-branch must be present');
});

// --- buildPrChecksWatchArgs ---

test('buildPrChecksWatchArgs: returns correct gh argv', () => {
  const args = buildPrChecksWatchArgs({ branch: 'inner/task-26' });
  assert.deepEqual(args, ['pr', 'checks', 'inner/task-26', '--watch']);
});

test('buildPrChecksWatchArgs: branch name is the third element', () => {
  const args = buildPrChecksWatchArgs({ branch: 'feat/foo' });
  assert.equal(args[2], 'feat/foo');
});

// --- buildPrMergeFallbackArgs ---

test('buildPrMergeFallbackArgs: returns correct gh argv (no --auto)', () => {
  const args = buildPrMergeFallbackArgs({ branch: 'inner/task-26' });
  assert.deepEqual(args, ['pr', 'merge', 'inner/task-26', '--squash', '--delete-branch']);
});

test('buildPrMergeFallbackArgs: does NOT include --auto (CI green already confirmed before call)', () => {
  const args = buildPrMergeFallbackArgs({ branch: 'feat/foo' });
  assert.ok(!args.includes('--auto'), '--auto must NOT be present in fallback (branch protection not required)');
});

test('buildPrMergeFallbackArgs: --squash flag is present', () => {
  const args = buildPrMergeFallbackArgs({ branch: 'feat/foo' });
  assert.ok(args.includes('--squash'), '--squash must be present');
});

test('buildPrMergeFallbackArgs: --delete-branch flag is present', () => {
  const args = buildPrMergeFallbackArgs({ branch: 'feat/foo' });
  assert.ok(args.includes('--delete-branch'), '--delete-branch must be present');
});
