// launchd 追記 log の最低限運用（#201 分解 14）。launchd は StandardOutPath へ
// O_APPEND で追記し続けるため、放置すると同一 log が無限に太る。ここでは
// ①log dir の生成 ②7 日超の簡易 rotate（1 世代 .prev）だけを持つ。
// 判定は純関数（shouldRotateLog）で export・side effect（fs）は rotateAppendLog に隔離。

import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 追記 log の簡易 rotate 判定。ファイル作成時刻（birthtime）が maxAge を超えたら
 * rotate（同 log への追記が無限に太らない程度 — サイズ管理まではしない）。
 * birthtime が取れない環境（<= 0）は rotate しない（誤 rotate より肥大を選ぶ）。
 * @param {number} birthtimeMs
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function shouldRotateLog(birthtimeMs, nowMs, maxAgeMs = LOG_MAX_AGE_MS) {
  return Number.isFinite(birthtimeMs) && birthtimeMs > 0 && nowMs - birthtimeMs > maxAgeMs;
}

/**
 * log dir の生成＋7 日超 rotate（<log> → <log>.prev・1 世代のみ）。
 * 実行中プロセスの stdout fd は rename 後も同じ inode（= .prev 側）を指すため、
 * 本パスの出力は rotate 先に落ち、新 log は次パス（launchd の次回 open）から始まる。
 * @param {string} logPath
 * @param {{ log?: (msg: string) => void, nowMs?: number }} deps
 * @returns {boolean} rotate したか
 */
export function rotateAppendLog(logPath, { log = () => {}, nowMs = Date.now() } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  let stat;
  try { stat = statSync(logPath); } catch { return false; } // log 無し = dir 生成のみ
  if (!shouldRotateLog(stat.birthtimeMs, nowMs)) return false;
  rmSync(`${logPath}.prev`, { force: true });
  renameSync(logPath, `${logPath}.prev`);
  log(`log rotated: ${logPath} (opened ${stat.birthtime.toISOString()}) → .prev`);
  return true;
}

/**
 * パス冒頭処理: ISO timestamp 行（launchd が同一 log へ追記するため、パス境界を
 * 刻む）→ log dir 生成＋簡易 rotate。rotate 失敗はパスを止めない（非致命）。
 * @param {string} logPath
 * @param {{ log?: (msg: string) => void, dryRun?: boolean }} deps
 */
export function beginPassLog(logPath, { log = () => {}, dryRun = false } = {}) {
  log(`pass start at ${new Date().toISOString()}${dryRun ? ' (dry-run)' : ''}`);
  try {
    rotateAppendLog(logPath, { log });
  } catch (error) {
    log(`warning: log rotate failed (non-fatal): ${error.message}`);
  }
}
