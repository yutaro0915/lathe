// Tests for syncWithOriginMain (#263): 成功 / ff 不可 / fetch 失敗 の 3 分岐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncWithOriginMain } from './orchestrator-sync.mjs';

test('syncWithOriginMain: fetch + ff-only ともに成功 → ok: true', () => {
  const calls = [];
  const fakeSpawnSync = (_cmd, args) => {
    calls.push(args[0]);
    return { status: 0, stderr: '' };
  };
  const result = syncWithOriginMain({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['fetch', 'merge']);
});

test('syncWithOriginMain: fetch 失敗（ネットワーク断等）→ ok: false, reason に fetch failed を含む', () => {
  const fakeSpawnSync = (_cmd, args) => {
    if (args[0] === 'fetch') return { status: 1, stderr: 'network timeout' };
    return { status: 0, stderr: '' };
  };
  const result = syncWithOriginMain({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fetch failed/);
  assert.match(result.reason, /network timeout/);
});

test('syncWithOriginMain: fetch は成功・ff-only 不可（diverged）→ ok: false, reason に merge --ff-only failed を含む', () => {
  const fakeSpawnSync = (_cmd, args) => {
    if (args[0] === 'fetch') return { status: 0, stderr: '' };
    return { status: 1, stderr: 'Not possible to fast-forward, aborting.' };
  };
  const result = syncWithOriginMain({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /merge --ff-only failed/);
  assert.match(result.reason, /Not possible to fast-forward/);
});
