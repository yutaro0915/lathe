// Tests for launchd 追記 log の最低限運用（#201 分解 14）: 7 日超の rotate 判定
// （純関数）と rotateAppendLog / beginPassLog の fs 挙動（temp dir 内で完結）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_MAX_AGE_MS, beginPassLog, rotateAppendLog, shouldRotateLog } from './orchestrator-logs.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// --- shouldRotateLog（純関数） ---

test('shouldRotateLog: 7 日超の birthtime だけ rotate', () => {
  const now = Date.parse('2026-07-07T00:00:00Z');
  assert.equal(shouldRotateLog(now - 8 * DAY_MS, now), true);
  assert.equal(shouldRotateLog(now - 6 * DAY_MS, now), false);
  assert.equal(shouldRotateLog(now - LOG_MAX_AGE_MS, now), false, '境界ちょうどは rotate しない');
  assert.equal(shouldRotateLog(now - 8 * DAY_MS, now, 30 * DAY_MS), false, 'maxAge は指定可能');
});

test('shouldRotateLog: birthtime が取れない環境（<=0 / NaN）は rotate しない', () => {
  const now = Date.parse('2026-07-07T00:00:00Z');
  assert.equal(shouldRotateLog(0, now), false);
  assert.equal(shouldRotateLog(-1, now), false);
  assert.equal(shouldRotateLog(NaN, now), false);
});

// --- rotateAppendLog / beginPassLog（fs は temp dir に隔離） ---

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-orch-logs-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('rotateAppendLog: log dir が無ければ生成のみ（rotate せず false）', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'logs', 'orchestrator.log');
    assert.equal(rotateAppendLog(logPath), false);
    assert.equal(existsSync(join(dir, 'logs')), true, 'dir は生成される');
    assert.equal(existsSync(logPath), false, 'log 本体は作らない（launchd が open する）');
  });
});

test('rotateAppendLog: 7 日超の log は .prev へ 1 世代 rotate（既存 .prev は上書き）', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'orchestrator.log');
    writeFileSync(logPath, 'old pass lines\n', 'utf8');
    writeFileSync(`${logPath}.prev`, 'ancient\n', 'utf8');
    const { birthtimeMs } = statSync(logPath);
    // birthtime は偽装できないため、nowMs を「作成から 8 日後」に進めて判定させる
    const lines = [];
    assert.equal(rotateAppendLog(logPath, { log: (m) => lines.push(m), nowMs: birthtimeMs + 8 * DAY_MS }), true);
    assert.equal(existsSync(logPath), false, '本体は rename 済み');
    assert.equal(readFileSync(`${logPath}.prev`, 'utf8'), 'old pass lines\n', '.prev は上書き（1 世代）');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /log rotated:/);
  });
});

test('rotateAppendLog: 7 日以内の log は触らない', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'orchestrator.log');
    writeFileSync(logPath, 'fresh\n', 'utf8');
    utimesSync(logPath, new Date(), new Date());
    assert.equal(rotateAppendLog(logPath), false);
    assert.equal(readFileSync(logPath, 'utf8'), 'fresh\n');
    assert.equal(existsSync(`${logPath}.prev`), false);
  });
});

test('beginPassLog: 先頭に ISO timestamp 行（dry-run 注記つき）・rotate 失敗は非致命', () => {
  withTempDir((dir) => {
    const lines = [];
    beginPassLog(join(dir, 'logs', 'orchestrator.log'), { log: (m) => lines.push(m), dryRun: true });
    assert.match(lines[0], /^pass start at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(dry-run\)$/);
    // dir を先にファイルで塞いで mkdir を失敗させても throw しない（warning のみ）
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '', 'utf8');
    const lines2 = [];
    assert.doesNotThrow(() => beginPassLog(join(blocked, 'x', 'o.log'), { log: (m) => lines2.push(m) }));
    assert.match(lines2[1], /log rotate failed \(non-fatal\)/);
  });
});
