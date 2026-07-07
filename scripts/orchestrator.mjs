#!/usr/bin/env node
// CLI: node scripts/orchestrator.mjs [--max K] [--max-failures N] [--dry-run]
// 単一 orchestrator — 1 プロセス 1 パスの dispatch shell（#201 分解 9）。
// ①derive（orchestrator-derive）②classify（orchestrator-classify）③dispatch
// ④盤面投影（orchestrator 側は非致命）。launchd（5 分間隔）または手動起動。常駐しない。
//
// - lock: .lathe/orchestrator.lock（PID）。生存 PID があれば二重起動せず exit 0。
//   stale lock（PID 死）は take over する。
// - 実行中判定は worktree 非依存（#201 comment 2026-07-07 実測: worktree を持たない
//   plan-task 実行を見逃して二重 dispatch＝子 issue 重複投函の実害リスク）:
//   .lathe/runs/live-*.json マーカー（orchestrator が spawn 時に書き exit で消す）
//   ＋PID 生存確認で導出する。worktree 検出（inner-issue-<n>）は補助信号として
//   union（orchestrator 外で手動起動された driver の検出）。
// - dispatch は fire-and-forget（spawn して pass は即終了・live マーカーで次パスに引き継ぐ）。
//   子ライフサイクル（live marker 書き込み・EXPLAIN 後処理・outcome 記録）は
//   orchestrator 所有ラッパ scripts/dispatch-runner.mjs に集約。
//   circuit breaker は cross-pass ledger（.lathe/runs/outcomes.jsonl）で管理し、
//   breakerFromLedger が pass 冒頭で dispatch を抑制する。
// - dispatch は既存コマンドの spawn（新しい実行経路を作らない）:
//     PLAN / IMPLEMENT → node scripts/inner-loop.mjs <n>（run type は driver が label で選ぶ）
//     EXPLAIN          → claude -p（.claude/skills/explain-diff/SETUP.md §6 の正規形）
//     PR_REVIEW        → node scripts/review-engine.mjs --pr <n>
// - Touches 重複の直列化は inner-queue から吸収（parseTaskRunHints / pathsOverlap）。
//
// 純関数（args/lock 判定/live マーカー/outcome/breaker/dispatch spec/選択）は export
// してテスト対象。side effect（spawn/fs/gh）は下段に隔離。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { deriveSnapshot } from './orchestrator-derive.mjs';
import {
  CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PLAN, CLASS_PR_REVIEW,
  classifyAll, formatDecision, isDispatchClass, planBoardProjection,
} from './orchestrator-classify.mjs';
import { updateProjectItemStatus } from './inner-loop-projects.mjs';
import { INNER_SETTINGS_PATH } from './inner-loop-core.mjs';
import {
  ensureDoneExplainLabel, explainedIssueNumbersFrom,
  formatExplainPostProcessPlan,
  listExplainFileNames, selectDoneExplainRepairs,
} from './orchestrator-explain.mjs';
import {
  parseInnerIssueWorktrees, parseTaskRunHints, pathsOverlap,
} from './inner-queue-decisions.mjs';
import { beginPassLog } from './orchestrator-logs.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNS_DIR = join(REPO_ROOT, '.lathe', 'runs');
const LOCK_PATH = join(REPO_ROOT, '.lathe', 'orchestrator.lock');
const OUTCOMES_PATH = join(RUNS_DIR, 'outcomes.jsonl');
const DISPATCH_RUNNER = join(__dirname, 'dispatch-runner.mjs');

function log(msg) { process.stdout.write(`[orchestrator] ${msg}\n`); }
function die(msg) { process.stderr.write(`orchestrator: error: ${msg}\n`); process.exit(1); }

// --- CLI args ---

/**
 * @param {string[]} argv
 * @returns {{ max: number, maxFailures: number, dryRun: boolean }}
 */
export function parseOrchestratorArgs(argv) {
  let max = 5;
  let maxFailures = 3;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--max') { max = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--max=')) max = Number(arg.slice('--max='.length));
    else if (arg === '--max-failures') { maxFailures = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--max-failures=')) maxFailures = Number(arg.slice('--max-failures='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(max) || max <= 0) throw new Error('--max must be a positive integer');
  if (!Number.isInteger(maxFailures) || maxFailures < 0) throw new Error('--max-failures must be a non-negative integer');
  return { max, maxFailures, dryRun };
}

// --- Lock（PID・1 プロセス 1 パス） ---

/**
 * @param {{ pid?: number } | null} existing  既存 lock の中身（無ければ null）
 * @param {(pid: number) => boolean} isAlive
 * @returns {{ action: 'acquire' } | { action: 'exit', pid: number } | { action: 'takeover', stalePid: number | null }}
 */
export function decideLockAction(existing, isAlive) {
  if (!existing) return { action: 'acquire' };
  const pid = existing.pid;
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return { action: 'exit', pid };
  return { action: 'takeover', stalePid: Number.isInteger(pid) ? pid : null };
}

/** @param {number} pid @returns {boolean} */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // 権限エラー = 生存プロセス
  }
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function acquireLock() {
  const decision = decideLockAction(existsSync(LOCK_PATH) ? readJsonOrNull(LOCK_PATH) : null, isPidAlive);
  if (decision.action === 'exit') return { ok: false, pid: decision.pid };
  if (decision.action === 'takeover') log(`stale lock (pid=${decision.stalePid ?? '?'} dead) — taking over`);
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
  return { ok: true };
}

function releaseLock() {
  const current = readJsonOrNull(LOCK_PATH);
  if (current?.pid === process.pid) rmSync(LOCK_PATH, { force: true });
}

// --- Live マーカー（worktree 非依存の実行中判定） ---

export const CLASS_SLUGS = Object.freeze({
  [CLASS_PLAN]: 'plan',
  [CLASS_IMPLEMENT]: 'implement',
  [CLASS_EXPLAIN]: 'explain',
  [CLASS_PR_REVIEW]: 'pr-review',
});

/** @param {string} cls @param {number} number @returns {string} */
export function liveMarkerName(cls, number) {
  return `live-${CLASS_SLUGS[cls] ?? 'unknown'}-${number}.json`;
}

/**
 * live マーカー 1 件の検証つき parse。壊れた内容は null（stale 扱い）。
 * @param {string} content
 * @returns {{ pid: number, kind: 'issue'|'pr', number: number } | null}
 */
export function parseLiveMarker(content) {
  let data;
  try { data = JSON.parse(content); } catch { return null; }
  if (!Number.isInteger(data?.pid) || data.pid <= 0) return null;
  if (!Number.isInteger(data?.number) || data.number <= 0) return null;
  const kind = data.kind === 'pr' ? 'pr' : 'issue';
  return { pid: data.pid, kind, number: data.number };
}

/**
 * マーカー集合 → 実行中 target（PID 生存確認つき）。死んだ PID のマーカーは
 * stale として名前を返す（呼び出し側が掃除する）。
 * @param {Array<{ name: string, marker: { pid: number, kind: string, number: number } | null }>} entries
 * @param {(pid: number) => boolean} isAlive
 * @returns {{ issues: Set<number>, prs: Set<number>, stale: string[] }}
 */
export function deriveRunningTargets(entries, isAlive) {
  const issues = new Set();
  const prs = new Set();
  const stale = [];
  for (const { name, marker } of entries ?? []) {
    if (!marker || !isAlive(marker.pid)) { stale.push(name); continue; }
    (marker.kind === 'pr' ? prs : issues).add(marker.number);
  }
  return { issues, prs, stale };
}

function readLiveMarkerEntries() {
  let names = [];
  try { names = readdirSync(RUNS_DIR); } catch { return []; }
  return names
    .filter((name) => name.startsWith('live-') && name.endsWith('.json'))
    .map((name) => {
      let content = '';
      try { content = readFileSync(join(RUNS_DIR, name), 'utf8'); } catch { /* stale 扱い */ }
      return { name, marker: parseLiveMarker(content) };
    });
}

// --- Dispatch spec（既存コマンドの spawn 形） ---

// .claude/skills/explain-diff/SETUP.md §6 の正規形（最小権限のハード強制）。
export const EXPLAIN_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Grep', 'Glob', 'Write(explains/**)', 'Edit(explains/**)',
  'Bash(gh:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git ls-files:*)',
]);

/** @param {number} issueNumber @returns {string} */
export function buildExplainPrompt(issueNumber) {
  return `issue #${issueNumber} に対して .claude/skills/explain-diff/SKILL.md の解説 loop を実行して`;
}

/**
 * 決定 → spawn 仕様。orchestrator は既存コマンドを起動するだけで、実行内容の
 * 判断（run type・review 手順・教材形式）は各コマンド側に残す。
 * @param {{ class: string, number: number }} decision
 * @param {{ execPath?: string }} deps
 * @returns {{ command: string, args: string[], logKey: string }}
 */
export function buildDispatchSpec(decision, { execPath = process.execPath } = {}) {
  const n = String(decision.number);
  switch (decision.class) {
    case CLASS_PLAN:
    case CLASS_IMPLEMENT:
      return { command: execPath, args: ['scripts/inner-loop.mjs', n], logKey: `issue-${decision.number}` };
    case CLASS_EXPLAIN:
      return {
        command: 'claude',
        args: ['-p', buildExplainPrompt(decision.number), '--settings', INNER_SETTINGS_PATH, '--allowedTools', ...EXPLAIN_ALLOWED_TOOLS],
        logKey: `explain-${decision.number}`,
      };
    case CLASS_PR_REVIEW:
      return { command: execPath, args: ['scripts/review-engine.mjs', '--pr', n], logKey: `pr-review-${decision.number}` };
    default:
      throw new Error(`not a dispatch class: ${decision.class}`);
  }
}

// --- Outcome / circuit breaker（escalation は故障と数えない） ---

export const OUTCOME_SUCCESS = 'success';
export const OUTCOME_ESCALATION = 'escalation';
export const OUTCOME_FAILURE = 'failure';

/**
 * @param {{ exitCode: number, escalated: boolean }} p
 * @returns {string}
 */
export function classifyChildOutcome({ exitCode, escalated }) {
  if (exitCode === 0) return OUTCOME_SUCCESS;
  return escalated ? OUTCOME_ESCALATION : OUTCOME_FAILURE;
}

/**
 * breaker 遷移: success はリセット、failure は加算（maxFailures 到達で open）、
 * escalation は数えない（カウント不変・open もしない）。maxFailures=0 は無効化。
 * @param {{ consecutiveFailures: number, open: boolean }} state
 * @param {string} outcome
 * @param {number} maxFailures
 * @returns {{ consecutiveFailures: number, open: boolean }}
 */
export function applyBreaker(state, outcome, maxFailures) {
  if (outcome === OUTCOME_ESCALATION) return { ...state };
  if (outcome === OUTCOME_SUCCESS) return { consecutiveFailures: 0, open: state.open };
  const consecutiveFailures = state.consecutiveFailures + 1;
  const open = state.open || (maxFailures > 0 && consecutiveFailures >= maxFailures);
  return { consecutiveFailures, open };
}

/**
 * outcomes.jsonl の全レコードを fold して cross-pass breaker 状態を返す。
 * applyBreaker と同じ意味論を保存した跨パス純関数: success はリセット・failure は加算・
 * escalation は数えない。open になった時点で短絡（以降は読まない）。
 * @param {Array<{ outcome: string } | null>} records  JSON.parse 済みの ledger レコード
 * @param {number} maxFailures
 * @returns {{ consecutiveFailures: number, open: boolean }}
 */
export function breakerFromLedger(records, maxFailures) {
  let state = { consecutiveFailures: 0, open: false };
  for (const rec of records ?? []) {
    if (!rec?.outcome) continue;
    state = applyBreaker(state, rec.outcome, maxFailures);
    if (state.open) return state;
  }
  return state;
}

// --- Touches 直列化つきの選択（inner-queue から吸収） ---

function decisionTouches(decision) {
  if (decision.kind !== 'issue') return [];
  return parseTaskRunHints(decision.issue?.body ?? '').touches;
}

/**
 * 次に dispatch する決定の index。issue の Touches が実行中の決定と重なるものは
 * 後回し（同一パスの並行 writer を避ける）。PR review はパスを触らない。
 * @param {object[]} pending
 * @param {object[]} activeDecisions
 * @returns {number} 見つからなければ -1
 */
export function pickNextDispatch(pending, activeDecisions) {
  for (let i = 0; i < (pending ?? []).length; i += 1) {
    const touches = decisionTouches(pending[i]);
    if (touches.length === 0) return i;
    const conflict = (activeDecisions ?? []).some((active) =>
      decisionTouches(active).some((ap) => touches.some((cp) => pathsOverlap(ap, cp))));
    if (!conflict) return i;
  }
  return -1;
}

// --- Side effects: spawn（fire-and-forget）---
// dispatch は dispatch-runner.mjs を spawn して即返却。
// 子ライフサイクル（live marker・EXPLAIN 後処理・outcome 記録）は dispatch-runner が担う。

function spawnDecision(decision) {
  mkdirSync(RUNS_DIR, { recursive: true });
  // dispatch-runner の log() 警告（live marker 失敗・outcome 記録失敗等）を
  // logPath に集約する（stdio: 'ignore' だと非致命警告が無音になる運用リスクの解消）。
  const spec = buildDispatchSpec(decision);
  const logPath = join(RUNS_DIR, `${spec.logKey}.log`);
  let outFd = null;
  try { outFd = openSync(logPath, 'a'); } catch { /* 開けなくても spawn は試みる */ }
  let child;
  try {
    child = spawn(process.execPath, [
      DISPATCH_RUNNER, decision.class, decision.kind, String(decision.number),
    ], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'],
      detached: true,
    });
  } catch (err) {
    if (outFd !== null) closeSync(outFd);
    log(`warning: spawn dispatch-runner failed for ${decision.class} #${decision.number}: ${err.message}`);
    return;
  }
  child.unref();
  // fd は子プロセスに継承済み — 親コピーは閉じてよい
  if (outFd !== null) closeSync(outFd);
}

// --- Outcome ledger（cross-pass circuit breaker） ---

function readOutcomeLedger() {
  try {
    const content = readFileSync(OUTCOMES_PATH, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// --- Dispatch（fire-and-forget・1 パス）---

/**
 * eligible な決定を spawn して即返却。完走を待たず live マーカーで次パスに引き継ぐ。
 * @param {{ dispatches: object[], max: number, spawnFn?: Function }} opts
 * @returns {{ dispatched: number, deferred: number }}
 */
export function runDispatch({ dispatches, max, spawnFn = spawnDecision }) {
  const pending = [...dispatches];
  const spawned = [];
  while (pending.length > 0 && spawned.length < max) {
    const idx = pickNextDispatch(pending, spawned);
    if (idx < 0) break;
    const [decision] = pending.splice(idx, 1);
    log(`DISPATCH ${formatDecision(decision)}`);
    spawnFn(decision);
    spawned.push(decision);
  }
  for (const d of pending) {
    log(`DEFER ${formatDecision(d)} — ${spawned.length >= max ? '並列上限到達' : 'Touches が実行中と重複'}（次パスで再判定）`);
  }
  return { dispatched: spawned.length, deferred: pending.length };
}

// --- 盤面投影（#201 分解 10・パス末尾・非致命） ---

// Approval 列（needs-review×教材あり×非 Ready）と Escalated 列（escalation label）
// への投影のみ（Escalated からの掃き出しはしない — 裁定待ち signal を消さないため）。option id は derive の名前解決結果を使う。
// 失敗は warning のみ（正本は導出、ADR 0035 §7 と同じ非致命規約）。
function applyBoardProjection(decisions, statusField, deps = {}) {
  const apply = deps.updateProjectItemStatus ?? updateProjectItemStatus;
  const { mutations, warnings } = planBoardProjection(decisions, statusField);
  for (const warning of warnings) log(`projection warning: ${warning}`);
  for (const m of mutations) {
    const result = apply(m.itemId, { fieldId: statusField.fieldId, optionId: m.optionId });
    if (result.ok) log(`projection: #${m.number} ${m.fromName ?? '(none)'} → ${m.toName}`);
    else log(`projection warning: #${m.number} → ${m.toName} failed (non-fatal): ${result.reason}`);
  }
  return mutations.length;
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let parsed;
  try {
    parsed = parseOrchestratorArgs(process.argv.slice(2));
  } catch (e) {
    die(`${e.message}\nusage: node scripts/orchestrator.mjs [--max K] [--max-failures N] [--dry-run]`);
  }

  // パス冒頭 ISO timestamp ＋ .lathe/logs/ 生成・7 日超の簡易 rotate（#201 分解 14・非致命）
  beginPassLog(join(REPO_ROOT, '.lathe', 'logs', 'orchestrator.log'), { log, dryRun: parsed.dryRun });

  let locked = false;
  if (!parsed.dryRun) {
    const lock = acquireLock();
    if (!lock.ok) {
      log(`another orchestrator is running (pid=${lock.pid}) — exiting (1 プロセス 1 パス)`);
      process.exit(0);
    }
    locked = true;
    process.on('exit', releaseLock);
  }

  try {
    // ① derive（保存しない）
    const derived = deriveSnapshot();
    if (!derived.ok) die(derived.reason);
    const { snapshot } = derived;
    for (const warning of snapshot.warnings) log(`warning: ${warning}`);

    // 実行中判定: live マーカー＋PID 生存（worktree 非依存）∪ worktree 補助信号
    const entries = readLiveMarkerEntries();
    const running = deriveRunningTargets(entries, isPidAlive);
    for (const name of running.stale) {
      rmSync(join(RUNS_DIR, name), { force: true });
      log(`stale live marker removed: ${name} (PID dead)`);
    }
    const wt = spawnSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (wt.status === 0) {
      for (const [issueNumber] of parseInnerIssueWorktrees(wt.stdout)) running.issues.add(issueNumber);
    }

    // ② classify（決定的・分類表は常に表示）。教材 evidence は label（derive 済み）に
    // 加えて explains/ の対象 slug 正本（#201 分解 13 — 重複生成防止の第 2 層）。
    const explainedIssueNumbers = explainedIssueNumbersFrom(listExplainFileNames());
    const decisions = classifyAll(snapshot, running, { explainedIssueNumbers });
    for (const decision of decisions) log(formatDecision(decision));
    const dispatches = decisions.filter((d) => isDispatchClass(d.class));

    // done-explain repair（非致命・#201 分解 13）: explains/ 正本あり × label なしの自己修復。
    const repairs = selectDoneExplainRepairs(decisions, explainedIssueNumbers);

    if (parsed.dryRun) {
      const plan = planBoardProjection(decisions, snapshot.statusField);
      for (const warning of plan.warnings) log(`dry-run: projection warning: ${warning}`);
      for (const m of plan.mutations) log(`dry-run: projection #${m.number} ${m.fromName ?? '(none)'} → ${m.toName}`);
      for (const d of repairs) log(`dry-run: done-explain repair #${d.number}（explains/ 正本あり・label 未付与 — 冪等付与する）`);
      for (const d of dispatches.filter((x) => x.class === CLASS_EXPLAIN)) log(`dry-run: ${formatExplainPostProcessPlan(d.number)}`);
      log(`dry-run: would dispatch ${dispatches.length} item(s), 並列上限 ${parsed.max} — spawn しない`);
      process.exit(0);
    }

    for (const d of repairs) {
      const repaired = ensureDoneExplainLabel(d.number);
      log(repaired.ok
        ? `done-explain repair: #${d.number}（explains/ 正本あり・label 未付与 → 冪等付与）`
        : `warning: done-explain repair #${d.number} failed (non-fatal): ${repaired.reason}`);
    }

    // ③ dispatch（EXPLAIN 後処理は dispatch-runner が子完走後に担う）
    // cross-pass circuit breaker: ledger の連続 failure が maxFailures に達していたら skip。
    const ledgerRecords = readOutcomeLedger();
    const breakerState = breakerFromLedger(ledgerRecords, parsed.maxFailures);
    if (breakerState.open) {
      log(`circuit breaker open (consecutiveFailures=${breakerState.consecutiveFailures}, maxFailures=${parsed.maxFailures}) — dispatch skipped this pass`);
      const projected = applyBoardProjection(decisions, snapshot.statusField);
      log(`pass complete: dispatched=0 deferred=${dispatches.length} projected=${projected} (breaker open)`);
      process.exit(0);
    }
    const result = runDispatch({ dispatches, max: parsed.max });

    // ④ 盤面投影（実状態へ同期・非致命）
    const projected = applyBoardProjection(decisions, snapshot.statusField);
    log(`pass complete: dispatched=${result.dispatched} deferred=${result.deferred} projected=${projected}`);
  } finally {
    if (locked) releaseLock();
  }
}
