// Self-update: orchestrator パス冒頭の機械的 origin/main 同期（#263）。
// fail-safe: fetch 失敗・ff 不可は非致命 — 現行コードで走行継続。
// 仕様: 同期はプロセス自身には反映されない（次パスから新コードが有効になる）。
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * origin/main を fetch して ff-only でローカル main に同期する。
 * @param {{ spawnSync?: Function, cwd?: string }} [deps]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function syncWithOriginMain(deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const cwd = deps.cwd ?? REPO_ROOT;
  const fetch = run('git', ['fetch', 'origin', 'main'], { cwd, encoding: 'utf8' });
  if (fetch.status !== 0) {
    return { ok: false, reason: `fetch failed (exit=${fetch.status}): ${(fetch.stderr ?? '').trim()}` };
  }
  const merge = run('git', ['merge', '--ff-only', 'origin/main'], { cwd, encoding: 'utf8' });
  if (merge.status !== 0) {
    return { ok: false, reason: `merge --ff-only failed (exit=${merge.status}): ${(merge.stderr ?? '').trim()}` };
  }
  return { ok: true };
}
