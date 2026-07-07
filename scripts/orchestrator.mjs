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
// - circuit breaker: 連続 failure が --max-failures 件で dispatch 停止。
//   escalation は故障と数えない（#201: PdM 裁定待ちの正常経路であり系の故障ではない）。
// - dispatch は既存コマンドの spawn（新しい実行経路を作らない）:
//     PLAN / IMPLEMENT → node scripts/inner-loop.mjs <n>（run type は driver が label で選ぶ）
//     EXPLAIN          → claude -p（.claude/skills/explain-diff/SETUP.md §6 の正規形）。
//                        完走（exit 0）後は orchestrator-explain.mjs の後処理 —
//                        explains/ 正本の自動 PR（Refs のみ・Closes しない）＋
//                        done-explain 冪等付与（#201 分解 13・非致命）
//     PR_REVIEW        → node scripts/review-engine.mjs --pr <n>
// - Touches 重複の直列化は inner-queue から吸収（parseTaskRunHints / pathsOverlap）。
//
// 純関数（args/lock 判定/live マーカー/outcome/breaker/dispatch spec/選択）は export
// してテスト対象。side effect（spawn/fs/gh）は下段に隔離。

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, statSync, writeFileSync,
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
import { INNER_SETTINGS_PATH } from './inner-loop-backends.mjs';
import {
  ensureDoneExplainLabel, explainedIssueNumbersFrom, formatExplainPostProcessPlan,
  listExplainFileNames, runExplainPostProcess, selectDoneExplainRepairs,
} from './orchestrator-explain.mjs';
import {
  ESCALATION_LABEL, parseInnerIssueWorktrees, parseTaskRunHints, pathsOverlap,
} from './inner-queue-decisions.mjs';
import { beginPassLog } from './orchestrator-logs.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNS_DIR = join(REPO_ROOT, '.lathe', 'runs');
const LOCK_PATH = join(REPO_ROOT, '.lathe', 'orchestrator.lock');

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

// --- Side effects: spawn / escalation 検出 ---

// 非ゼロ exit が escalation（裁定待ちの正常経路）かを導出する。
// ①escalation ファイル（現行 driver の provisional surface）が spawn 以降に更新
// ②issue に escalation label（#203 で正本化される投影先）— どちらかで true。
function detectEscalation(decision, spawnedAtMs, deps = {}) {
  if (decision.kind !== 'issue') return false;
  for (const kind of ['issue', 'plan']) {
    try {
      const stat = statSync(join(RUNS_DIR, `${kind}-${decision.number}.escalation.md`));
      if (stat.mtimeMs >= spawnedAtMs - 1000) return true;
    } catch { /* ファイルなし */ }
  }
  const run = deps.spawnSync ?? spawnSync;
  const r = run('gh', ['issue', 'view', String(decision.number), '--json', 'labels'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) return false;
  try {
    const labels = JSON.parse(r.stdout)?.labels ?? [];
    return labels.some((l) => String(l?.name ?? l).toLowerCase() === ESCALATION_LABEL);
  } catch { return false; }
}

function spawnDecision(decision) {
  const spec = buildDispatchSpec(decision);
  const logPath = join(RUNS_DIR, `${spec.logKey}.log`);
  mkdirSync(RUNS_DIR, { recursive: true });
  const spawnedAtMs = Date.now();
  appendFileSync(logPath, `[orchestrator] start ${decision.class} ${decision.kind} #${decision.number} at ${new Date(spawnedAtMs).toISOString()}\n`);

  return new Promise((resolve) => {
    const fd = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', fd, fd] });
    } catch (error) {
      closeSync(fd);
      appendFileSync(logPath, `[orchestrator] spawn error: ${error.message}\n`);
      resolve({ exitCode: 1, spawnedAtMs });
      return;
    }
    closeSync(fd);

    const markerPath = join(RUNS_DIR, liveMarkerName(decision.class, decision.number));
    try {
      writeFileSync(markerPath, `${JSON.stringify({
        pid: child.pid, class: decision.class, kind: decision.kind, number: decision.number,
        startedAt: new Date(spawnedAtMs).toISOString(),
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log(`warning: live marker write failed for ${markerPath}: ${error.message}`);
    }

    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      try { rmSync(markerPath, { force: true }); } catch { /* stale 掃除は次パスが拾う */ }
      try { appendFileSync(logPath, `[orchestrator] done exit=${exitCode} at ${new Date().toISOString()}\n`); } catch { /* log は非致命 */ }
      resolve({ exitCode, spawnedAtMs });
    };
    child.on('error', (error) => {
      appendFileSync(logPath, `[orchestrator] spawn error: ${error.message}\n`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

// --- Dispatch loop（1 パス・refill あり・breaker つき） ---

async function runDispatch({ dispatches, max, maxFailures }) {
  const pending = [...dispatches];
  /** @type {Array<{ decision: object, promise: Promise<{exitCode:number,spawnedAtMs:number}> }>} */
  const active = [];
  let breaker = { consecutiveFailures: 0, open: false };
  const counts = { dispatched: 0, success: 0, escalated: 0, failed: 0 };

  while ((pending.length > 0 && !breaker.open) || active.length > 0) {
    while (!breaker.open && pending.length > 0 && active.length < max) {
      const idx = pickNextDispatch(pending, active.map((entry) => entry.decision));
      if (idx < 0) break;
      const [decision] = pending.splice(idx, 1);
      log(`DISPATCH ${formatDecision(decision)}`);
      counts.dispatched += 1;
      active.push({ decision, promise: spawnDecision(decision) });
    }

    if (active.length === 0) break;

    const settled = await Promise.race(
      active.map((entry, index) => entry.promise.then((result) => ({ index, result }))),
    );
    const [done] = active.splice(settled.index, 1);
    const { exitCode, spawnedAtMs } = settled.result;
    const escalated = exitCode !== 0 && detectEscalation(done.decision, spawnedAtMs);
    const outcome = classifyChildOutcome({ exitCode, escalated });
    counts[outcome === OUTCOME_SUCCESS ? 'success' : outcome === OUTCOME_ESCALATION ? 'escalated' : 'failed'] += 1;
    const before = breaker;
    breaker = applyBreaker(breaker, outcome, maxFailures);
    log(`DONE ${done.decision.class} ${done.decision.kind === 'pr' ? 'PR ' : ''}#${done.decision.number} exit=${exitCode} outcome=${outcome}`);
    // EXPLAIN 完走後処理（#201 分解 13・非致命）: explains/ 正本の自動 PR ＋
    // done-explain 冪等付与。runner の allowed-tools は explains/ 書き込みまで —
    // git 着地と label 保証は機械側の責務。
    if (done.decision.class === CLASS_EXPLAIN && outcome === OUTCOME_SUCCESS) {
      try {
        runExplainPostProcess(done.decision.number, { log });
      } catch (error) {
        log(`warning: explain post #${done.decision.number} failed (non-fatal): ${error.message}`);
      }
    }
    if (breaker.open && !before.open) {
      log(`CIRCUIT_OPEN after ${maxFailures} consecutive failures — dispatch halted (escalation は数えない)`);
    }
  }

  for (const decision of pending) {
    log(`DEFER ${formatDecision(decision)} — ${breaker.open ? 'circuit open' : 'Touches が実行中と重複（次パスで再判定）'}`);
  }
  return { ...counts, deferred: pending.length, breakerOpen: breaker.open };
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

    // ③ dispatch
    const result = await runDispatch({ dispatches, max: parsed.max, maxFailures: parsed.maxFailures });

    // ④ 盤面投影（実状態へ同期・非致命）
    const projected = applyBoardProjection(decisions, snapshot.statusField);
    log(`pass complete: dispatched=${result.dispatched} success=${result.success} escalated=${result.escalated} failed=${result.failed} deferred=${result.deferred} projected=${projected}${result.breakerOpen ? ' CIRCUIT_OPEN' : ''}`);
    process.exitCode = result.failed > 0 ? 1 : 0;
  } finally {
    if (locked) releaseLock();
  }
}
