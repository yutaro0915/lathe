// Tests for syncMainFfOnly (#263): 成功 / ff 不可 / fetch 失敗 の 3 分岐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMainFfOnly } from './orchestrator.mjs';

test('syncMainFfOnly: fetch + ff-only ともに成功 → status: synced', () => {
  const calls = [];
  const fakeSpawnSync = (_cmd, args) => {
    calls.push(args[0]);
    return { status: 0, stderr: '' };
  };
  const result = syncMainFfOnly({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.deepEqual(result, { status: 'synced' });
  assert.deepEqual(calls, ['fetch', 'merge']);
});

test('syncMainFfOnly: fetch 失敗（ネットワーク断等）→ status: fetch-failed, merge を呼ばない', () => {
  const calls = [];
  const fakeSpawnSync = (_cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 1, stderr: 'network timeout' };
    return { status: 0, stderr: '' };
  };
  const result = syncMainFfOnly({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.equal(result.status, 'fetch-failed');
  assert.match(result.detail, /fetch-failed|network timeout|exit=1/);
  // fetch 失敗時は merge を呼ばないことを呼び出し回数で確認
  assert.deepEqual(calls, ['fetch']);
});

test('syncMainFfOnly: fetch は成功・ff-only 不可（diverged）→ status: ff-not-possible', () => {
  const calls = [];
  const fakeSpawnSync = (_cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 0, stderr: '' };
    return { status: 1, stderr: 'Not possible to fast-forward, aborting.' };
  };
  const result = syncMainFfOnly({ spawnSync: fakeSpawnSync, cwd: '/tmp' });
  assert.equal(result.status, 'ff-not-possible');
  assert.match(result.detail, /Not possible to fast-forward/);
  assert.deepEqual(calls, ['fetch', 'merge']);
});
