#!/usr/bin/env node
// CLI: node scripts/dispatch-runner.mjs <class> <kind> <number>
// 子ライフサイクル管理ラッパ（orchestrator が 1 子 = 1 dispatch-runner を spawn する）:
//   ① live marker 書き込み
//   ② 実コマンド実行（同期: spawnSync で完走を待つ）
//   ③ EXPLAIN 後処理（CLASS_EXPLAIN のみ）
//   ④ outcome 記録（.lathe/runs/outcomes.jsonl に append-only JSONL）
//   ⑤ live marker 削除
// orchestrator は detached=true で spawn して即 unref — この wrapper が完走を引き受ける。
//
// 純関数（parseDispatchRunnerArgs / buildOutcomeRecord）は export してテスト対象。
// side effect（fs / spawn / gh）は isMain ブロックに隔離。

import {
  appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  buildDispatchSpec, classifyChildOutcome, liveMarkerName,
  OUTCOME_SUCCESS,
} from './orchestrator.mjs';
import { CLASS_EXPLAIN } from './orchestrator-classify.mjs';
import { detectNewExplainFiles, runExplainPostProcess } from './orchestrator-explain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNS_DIR = join(REPO_ROOT, '.lathe', 'runs');
export const OUTCOMES_PATH = join(RUNS_DIR, 'outcomes.jsonl');

function log(msg) { process.stdout.write(`[dispatch-runner] ${msg}\n`); }

// --- Pure functions ---

/**
 * CLI argv（process.argv.slice(2)）を解析して decision を返す。
 * @param {string[]} argv
 * @returns {{ class: string, kind: 'issue' | 'pr', number: number }}
 */
export function parseDispatchRunnerArgs(argv) {
  if ((argv ?? []).length < 3) throw new Error('usage: dispatch-runner <class> <kind> <number>');
  const [cls, kind, numStr] = argv;
  if (kind !== 'issue' && kind !== 'pr') throw new Error(`invalid kind: ${kind}`);
  const number = Number(numStr);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`invalid number: ${numStr}`);
  return { class: cls, kind, number };
}

/**
 * outcomes.jsonl 1 行分のレコードを構築する。
 * @param {{ class: string, kind: string, number: number }} decision
 * @param {string} outcome  'success' | 'escalation' | 'failure'
 * @param {number | null} exitCode
 * @param {string} ts  ISO 8601 timestamp（テスト注入用）
 * @returns {object}
 */
export function buildOutcomeRecord(decision, outcome, exitCode, ts) {
  return {
    ts: ts ?? new Date().toISOString(),
    class: decision.class,
    kind: decision.kind,
    number: decision.number,
    outcome,
    exitCode: exitCode ?? null,
  };
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let decision;
  try {
    decision = parseDispatchRunnerArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`dispatch-runner: ${e.message}\n`);
    process.exit(2);
  }

  mkdirSync(RUNS_DIR, { recursive: true });

  // dispatch spec から実コマンドを解決
  const spec = buildDispatchSpec(decision);
  const logPath = join(RUNS_DIR, `${spec.logKey}.log`);

  // ① live marker 書き込み（AC4）
  const markerPath = join(RUNS_DIR, liveMarkerName(decision.class, decision.number));
  try {
    writeFileSync(markerPath, `${JSON.stringify({
      pid: process.pid,
      class: decision.class,
      kind: decision.kind,
      number: decision.number,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch (err) {
    log(`warning: live marker write failed for ${markerPath}: ${err.message}`);
  }

  appendFileSync(logPath, `[dispatch-runner] start ${decision.class} ${decision.kind} #${decision.number} at ${new Date().toISOString()}\n`);

  // ② 実コマンド実行（同期）
  const fd = openSync(logPath, 'a');
  let exitCode = 1;
  try {
    const result = spawnSync(spec.command, spec.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', fd, fd],
    });
    exitCode = result.status ?? 1;
  } finally {
    closeSync(fd);
  }

  // ③ EXPLAIN 後処理（AC5: EXPLAIN クラスのみ・非致命）
  if (decision.class === CLASS_EXPLAIN) {
    try {
      const det = detectNewExplainFiles(decision.number);
      if (det.ok && det.files.length > 0) runExplainPostProcess(decision.number, { log });
    } catch (err) {
      log(`warning: explain post-process #${decision.number} failed (non-fatal): ${err.message}`);
    }
  }

  // ④ outcome 記録（outcomes.jsonl — circuit breaker が cross-pass で読む）
  // escalation の exit code 規約は現状未定義 → exit 0 = success / non-zero = failure で記録。
  // 将来、inner-loop が escalation exit code 規約を確立した時点で classifyChildOutcome に渡す。
  const outcome = classifyChildOutcome({ exitCode, escalated: false });
  const record = buildOutcomeRecord(decision, outcome, exitCode);
  try {
    appendFileSync(OUTCOMES_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    log(`warning: outcome record write failed (non-fatal): ${err.message}`);
  }

  // ⑤ live marker 削除（AC4）
  try {
    rmSync(markerPath, { force: true });
  } catch { /* 次パスの stale 掃除が拾う */ }

  appendFileSync(logPath, `[dispatch-runner] done exit=${exitCode} outcome=${outcome} at ${new Date().toISOString()}\n`);
  process.exit(outcome === OUTCOME_SUCCESS ? 0 : 1);
}
