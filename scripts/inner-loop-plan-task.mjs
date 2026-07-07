// inner-loop-plan-task.mjs — the plan-task run type (ADR 0030 §2, #116).
// A `needs-plan` labelled issue is a plan-task: the planner agent produces a
// confirmed plan; the terminal is「plan の確定＋子 issue の投函」(intake へ還流
// — child issue creation IS the registration, ADR 0031). Implementation and
// landing are NOT part of the terminal. When the planner reaches an option
// set that needs a PdM decision, ASK_PDM is a NORMAL terminal (not an
// escalation, ADR 0030 追記 E): the options are posted as a comment and the
// source issue stays open.
//
// Replaces the deleted issue-origin plan-loop (RESEARCH → PLAN → PLAN_REVIEW →
// GATE → ISSUE_CREATE → CLOSE_SOURCE, ADR 0016) and its backlog CLI wiring
// (`backlog task create`, ADR 0031 §3). plan-format.md is injected into the
// PLAN prompt fail-closed (#142 absorbed into #116).
//
// Pure logic is exported for unit testing; gh side effects take a deps
// injection point ({ spawnSync }).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { DRIVER_CONFIG } from './inner-loop-config.mjs';
import { buildStagePrompt } from './inner-loop-prompts.mjs';
import { selectBackend } from './inner-loop-backends.mjs';
import { runStage, logDryRunStage } from './inner-loop-stage-runner.mjs';
import { projectEscalation } from './inner-loop-escalation.mjs';
import {
  REPO_ROOT, PLAN_FORMAT_PATH, TASK_REQUEST_LABEL, NEEDS_PLAN_LABEL,
  PLAN_TASK_STAGES, PLAN_TASK_TERMINAL,
  UNPARSABLE_VERDICT,
  nextPlanTaskState, runStageWithUnparsableRetry,
  buildManifestEntry, buildManifest, manifestPathFor, backendCostSourceForEnvelope,
  readManifestStages, tailLines, parseBlockedBy,
} from './inner-loop-core.mjs';
import {
  stripVerdictLine, parsePlanChildBlocks,
  validatePlanChildBlocks, buildPlanValidationFeedback, decidePlanValidationAction,
} from './inner-loop-plan-validate.mjs';

// FILE_CHILDREN の書式検証層（#201 Wave4）は inner-loop-plan-validate.mjs が
// 正本（純関数・file-size rubric のための分離）。既存 importer 向けに再輸出。
export {
  parseBlockedByLine, parsePlanChildBlocks,
  validatePlanChildBlocks, buildPlanValidationFeedback, decidePlanValidationAction,
} from './inner-loop-plan-validate.mjs';

function die(msg) { process.stderr.write(`inner-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[inner-loop] ${msg}\n`); }

// --- Pure / testable exports ---

/**
 * Resolve plan-local `plan#<k>` references to already-created child issue
 * numbers (as `#<n>`).
 * @param {string} blockedBy
 * @param {Map<number, number>} createdIssueNumbersByPlanIndex
 * @returns {{ ok: true, blockedBy: string } | { ok: false, error: string }}
 */
export function resolvePlanChildDependency(blockedBy, createdIssueNumbersByPlanIndex) {
  const unresolved = [];
  const resolved = String(blockedBy ?? '').replace(/\bplan#(\d+)\b/gi, (token, rawIndex) => {
    const index = Number(rawIndex);
    const issueNumber = createdIssueNumbersByPlanIndex.get(index);
    if (!issueNumber) {
      unresolved.push(token);
      return token;
    }
    return `#${issueNumber}`;
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `unresolved plan-local dependency reference(s): ${unresolved.join(', ')}` };
  }
  return { ok: true, blockedBy: resolved };
}

/**
 * Build a child issue body: provenance line, machine-readable `blocked-by`
 * (parent always included — 親子間に blocked-by を張る, #116), `Touches:` for
 * the queue's overlap check, then the plan block (the plan the child is born
 * with, ADR 0030 §2).
 * @param {{ parentIssueNumber: number, blockedBy: string, touches: string, plan: string }} p
 * @returns {string}
 */
export function buildChildIssueBody({ parentIssueNumber, blockedBy, touches, plan }) {
  const refs = [`#${parentIssueNumber}`];
  for (const ref of String(blockedBy ?? '').matchAll(/#(\d+)/g)) {
    const token = `#${ref[1]}`;
    if (!refs.includes(token)) refs.push(token);
  }
  return [
    `Generated from #${parentIssueNumber} (plan-task)`,
    `blocked-by ${refs.join(', ')}`,
    `Touches: ${touches ?? ''}`,
    '',
    stripVerdictLine(plan),
    '',
  ].join('\n');
}

/**
 * Parse the created issue number from `gh issue create` stdout (the issue URL).
 * @param {string} output
 * @returns {number | null}
 */
export function parseCreatedIssueNumber(output) {
  const match = String(output ?? '').match(/\/issues\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * File the child issues for a confirmed plan (plan-task terminal).
 * @param {number} parentIssueNumber
 * @param {string} planText
 * @param {{ spawnSync?: Function }} deps
 * @returns {{ ok: true, children: Array<{ index: number, issueNumber: number, title: string, body: string }>, rejected: Array<object> } | { ok: false, error: string }}
 */
export function createChildIssues(parentIssueNumber, planText, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const parsed = parsePlanChildBlocks(planText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const children = [];
  const createdIssueNumbersByPlanIndex = new Map();
  for (const block of parsed.children) {
    const blockedByResult = resolvePlanChildDependency(block.blockedBy, createdIssueNumbersByPlanIndex);
    if (!blockedByResult.ok) {
      return { ok: false, error: `plan block ${block.index}: ${blockedByResult.error}` };
    }
    const body = buildChildIssueBody({
      parentIssueNumber,
      blockedBy: blockedByResult.blockedBy,
      touches: block.touches,
      plan: block.plan,
    });
    const r = run('gh', ['issue', 'create', '--title', block.title, '--label', TASK_REQUEST_LABEL, '--body-file', '-'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: body,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      return { ok: false, error: `gh issue create failed for plan#${block.index}: ${r.stderr || r.stdout}` };
    }
    const issueNumber = parseCreatedIssueNumber(r.stdout);
    if (!issueNumber) {
      return { ok: false, error: `could not parse created issue number from gh output: ${r.stdout}` };
    }
    children.push({ index: block.index, issueNumber, title: block.title, body });
    createdIssueNumbersByPlanIndex.set(block.index, issueNumber);
  }

  return { ok: true, children, rejected: parsed.rejected };
}

/**
 * Close-out comment for the plan-task source issue: the confirmed plan and
 * the filed children (plan の確定 = issue comment への反映, #116).
 * @param {{ children: Array<{index:number, issueNumber:number, title:string}>, rejected: Array<{candidate:string, reason:string}>, planText: string }} p
 * @returns {string}
 */
export function buildPlanTaskCloseComment({ children, rejected, planText }) {
  const lines = ['plan-task completed — plan confirmed, child issues filed:', ''];
  for (const child of children) {
    lines.push(`- plan#${child.index} -> #${child.issueNumber}: ${child.title}`);
  }
  lines.push('', 'Rejected candidates:');
  if (rejected.length === 0) {
    lines.push('- none');
  } else {
    for (const candidate of rejected) {
      lines.push(`- ${candidate.candidate} — ${candidate.reason}`);
    }
  }
  lines.push('', '## confirmed plan', '', stripVerdictLine(planText));
  return lines.join('\n');
}

/**
 * Comment body for the ASK_PDM terminal (正常終端 — the source issue stays
 * open for the PdM's decision, ADR 0030 追記 E).
 * @param {{ resultText: string }} p
 * @returns {string}
 */
export function buildAskPdmComment({ resultText }) {
  return [
    'plan-task paused — PdM 判断が必要な選択肢に到達しました（escalation ではなく正常終端です。ADR 0030 追記 E）。',
    '',
    stripVerdictLine(resultText),
  ].join('\n');
}

/**
 * GitHub の issue comment 本文上限（65,536 文字）で body を分割する。
 * 改行境界で切り、改行が見つからない場合は maxLen でハード分割する。
 * @param {string} body
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export const COMMENT_BODY_MAX = 65536;

export function splitCommentBody(body, maxLen = COMMENT_BODY_MAX) {
  const s = String(body ?? '');
  if (s.length <= maxLen) return [s];
  const chunks = [];
  let start = 0;
  while (start < s.length) {
    if (start + maxLen >= s.length) {
      chunks.push(s.slice(start));
      break;
    }
    // Find the last newline within the window
    const windowEnd = start + maxLen - 1;
    let splitAt = s.lastIndexOf('\n', windowEnd);
    if (splitAt <= start) {
      // No newline found in window — hard split at maxLen
      splitAt = start + maxLen;
      chunks.push(s.slice(start, splitAt));
      start = splitAt;
    } else {
      chunks.push(s.slice(start, splitAt));
      start = splitAt + 1; // skip the newline itself
    }
  }
  return chunks;
}

// Fail-closed read of design/plan-format.md (#142 absorbed into #116): a
// plan-task run must not start with an uninjected prompt.
export function readPlanFormatOrDie() {
  const path = join(REPO_ROOT, PLAN_FORMAT_PATH);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    die(`plan-format injection failed (fail-closed, #142): could not read ${PLAN_FORMAT_PATH}: ${e.message}`);
  }
  if (!text.trim()) {
    die(`plan-format injection failed (fail-closed, #142): ${PLAN_FORMAT_PATH} is empty`);
  }
  return text;
}

// --- Side-effect helpers (manifest / escalation / terminals) ---

function appendPlanManifestEntry(issueNumber, entry) {
  const unit = { kind: 'plan', id: issueNumber };
  const p = manifestPathFor(unit);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildManifest(unit, stages), null, 2) + '\n', 'utf8');
}

// escalation の issue 化 (#201 分解 6): 対象 issue に escalation label ＋
// レポート全文 comment を投影する（.escalation.md は廃止・非致命）。
function escalatePlanTask(issueNumber, stage, verdict, resultExcerpt) {
  projectEscalation({ issueNumber, stage, verdict, resultExcerpt, runType: 'plan-task' }, { log });
}

// deps 注入点（land 流儀）: runPlanTask と terminal 完了処理が共有する。
// 省略時はモジュール既定の副作用（spawnSync / manifest 書き込み / escalation /
// process.exit）に落ちる。
function resolvePlanTaskDeps(issueNumber, deps = {}) {
  return {
    run: deps.spawnSync ?? spawnSync,
    runStageFn: deps.runStage ?? runStage,
    logFn: deps.log ?? log,
    dieFn: deps.die ?? die,
    record: deps.recordManifestEntry ?? ((entry) => appendPlanManifestEntry(issueNumber, entry)),
    escalate: deps.escalate ?? escalatePlanTask,
  };
}

function completeFileChildren(issueNumber, planText, deps = {}) {
  const { run, logFn, dieFn, record, escalate } = resolvePlanTaskDeps(issueNumber, deps);
  const created = createChildIssues(issueNumber, planText, deps);
  if (!created.ok) {
    escalate(issueNumber, PLAN_TASK_TERMINAL, null, created.error);
    dieFn(`plan-task child issue filing failed — see the escalation report comment on issue #${issueNumber}`);
  }
  record(buildManifestEntry({
    stage: PLAN_TASK_TERMINAL,
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: created.children.map((child) => `created plan#${child.index} -> #${child.issueNumber}: ${child.title}`).join('\n'),
  }));
  logFn(`plan-task filed ${created.children.length} child issue(s): ${created.children.map((child) => `#${child.issueNumber}`).join(', ')}`);

  const comment = buildPlanTaskCloseComment({
    children: created.children,
    rejected: created.rejected,
    planText,
  });
  const r = run('gh', ['issue', 'close', String(issueNumber), '--reason', 'completed', '--comment', comment], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    escalate(issueNumber, 'CLOSE_SOURCE', null, `gh issue close failed\n\n${tailLines(`${r.stdout ?? ''}${r.stderr ?? ''}`)}`);
    dieFn(`plan-task source close failed — see the escalation report comment on issue #${issueNumber}`);
  }
  record(buildManifestEntry({
    stage: 'CLOSE_SOURCE',
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: `closed source issue #${issueNumber}`,
  }));
  logFn(`plan-task done — plan confirmed, child issue(s) ${created.children.map((child) => `#${child.issueNumber}`).join(', ')} filed, source issue #${issueNumber} closed.`);
  return 0;
}

function completeAskPdm(issueNumber, resultText, deps = {}) {
  const { run, logFn, dieFn, record } = resolvePlanTaskDeps(issueNumber, deps);
  const body = buildAskPdmComment({ resultText });
  const chunks = splitCommentBody(body);
  for (const chunk of chunks) {
    const r = run('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: chunk,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.status !== 0) dieFn(`gh issue comment failed for ASK_PDM terminal: ${r.stderr || r.stdout}`);
  }
  record(buildManifestEntry({
    stage: 'ASK_PDM',
    sessionId: null,
    verdict: 'ASK_PDM',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: body,
  }));
  logFn(`plan-task paused at PdM decision (正常終端) — options posted as a comment on issue #${issueNumber}; the issue stays open.`);
  return 0;
}

// --- Runner and dry-run ---

export function dryRunPlanTask(issueNumber, issue, backendFlags) {
  const planFormat = readPlanFormatOrDie();
  log(`dry-run: plan-task issue #${issueNumber} (${NEEDS_PLAN_LABEL} label present)`);
  log(`dry-run: manifest ${manifestPathFor({ kind: 'plan', id: issueNumber })}`);
  const refs = parseBlockedBy(issue.body);
  log(refs.length === 0
    ? 'dry-run: blocked-by — no refs in issue body'
    : `dry-run: blocked-by — would check ${refs.map((n) => `#${n}`).join(', ')} via gh issue view --json state; any OPEN ref refuses the run`);
  log(`dry-run: stage plan — ${PLAN_TASK_STAGES.join(' -> ')} -> ${PLAN_TASK_TERMINAL}`);
  log(`dry-run: plan-format injection — ${PLAN_FORMAT_PATH} read fail-closed (${planFormat.length} chars); missing/empty file aborts the run before spawning`);
  for (const stage of PLAN_TASK_STAGES) {
    const promptPreview = buildStagePrompt(stage, {
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      comments: issue.comments,
      planFormat,
    });
    logDryRunStage(stage, backendFlags, REPO_ROOT, promptPreview);
  }
  log(`dry-run: ${PLAN_TASK_TERMINAL} — validate child blocks (validatePlanChildBlocks: Title/Blocked-by/Touches + plan#<k> 後方参照のみ), gh issue create --label ${TASK_REQUEST_LABEL} per block (body carries blocked-by #${issueNumber} + resolved plan#<k> refs), then gh issue close ${issueNumber} --reason completed --comment '<confirmed plan + children>'`);
  log('dry-run: ASK_PDM — post the options as an issue comment and exit 0 with the source issue left open (正常終端)');
  log(`dry-run: transition plan — PLAN_READY->validate->FILE_CHILDREN (format RED -> 所見を PLAN へ差し戻して再試行、上限 ${DRIVER_CONFIG.maxPlanChildrenValidationRetries}・再 RED -> ESCALATE), ASK_PDM->ASK_PDM (normal terminal), missing/unparsable VERDICT->same stage retry once then ESCALATE`);
}

/**
 * Run a plan-task to one of its terminals. Returns a process exit code.
 * @param {number} issueNumber
 * @param {{ title: string, body: string, comments?: Array<object> }} issue
 * @param {{ global: string|null, stages: Record<string,string> }} backendFlags
 * @param {{ runStage?: Function, spawnSync?: Function, recordManifestEntry?: Function,
 *           escalate?: Function, log?: Function, die?: Function }} deps
 *   land 流儀の注入点（テスト用。省略時はモジュール既定の副作用）。
 * @returns {number}
 */
export function runPlanTask(issueNumber, issue, backendFlags, deps = {}) {
  const { runStageFn, logFn, dieFn, record, escalate } = resolvePlanTaskDeps(issueNumber, deps);
  const planFormat = readPlanFormatOrDie();
  let state = PLAN_TASK_STAGES[0];
  let planText = '';
  // FILE_CHILDREN 書式検証の修正周回（#201 Wave4）: NG 所見は次の PLAN prompt
  // に buildReviewFeedbackSection 経由で注入される。
  let validationRetriesUsed = 0;
  let validationFeedback = null;

  while (PLAN_TASK_STAGES.includes(state)) {
    const prompt = buildStagePrompt(state, {
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      comments: issue.comments,
      planFormat,
      reviewFeedback: validationFeedback ?? undefined,
    });
    const backend = selectBackend(state, backendFlags);
    logFn(`plan-task stage=${state} backend=${backend} cwd=${REPO_ROOT} — spawning ${backend}`);
    const stageResult = runStageWithUnparsableRetry({
      runAttempt: () => {
        const stageStartedAt = Date.now();
        const envelope = runStageFn(state, prompt, REPO_ROOT, null, backend);
        const durationMs = Math.max(1, Date.now() - stageStartedAt);
        return { envelope, durationMs };
      },
      recordAttempt: ({ envelope, manifestVerdict, durationMs }) => {
        record(buildManifestEntry({
          stage: state,
          sessionId: envelope.session_id ?? null,
          verdict: manifestVerdict,
          backendCostUsd: envelope.total_cost_usd ?? null,
          backendCostSource: backendCostSourceForEnvelope(envelope),
          backendModel: envelope.backend_model ?? null,
          backendTokenUsage: envelope.backend_token_usage ?? null,
          durationMs,
          backend: envelope.backend ?? null,
          resultText: envelope.result ?? '',
        }));
      },
      onRetry: () => logFn(`plan-task stage=${state} verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });
    const { envelope, verdict } = stageResult;

    if (verdict === null) {
      escalate(issueNumber, state, UNPARSABLE_VERDICT, envelope.result ?? '');
      state = 'ESCALATE';
      break;
    }

    if (verdict === 'PLAN_READY' || verdict === 'ASK_PDM') planText = envelope.result;

    const { next } = nextPlanTaskState(state, verdict);

    // FILE_CHILDREN 前の書式検証（#201 Wave4）: 書式逸脱は escalate 即死させず、
    // 指摘リストを PLAN に差し戻して informed retry（上限 1）。再 NG は escalation。
    // 黙った推測補正はしない — 検証・差し戻し・escalation の 3 段のみ。
    if (next === PLAN_TASK_TERMINAL) {
      const validation = validatePlanChildBlocks(planText);
      const action = decidePlanValidationAction({ validation, retriesUsed: validationRetriesUsed });
      if (action.action !== 'file') {
        const feedback = buildPlanValidationFeedback(validation.findings);
        record(buildManifestEntry({
          stage: PLAN_TASK_TERMINAL,
          sessionId: null,
          verdict: 'RED',
          backendCostUsd: null,
          backendCostSource: null,
          backend: null,
          resultText: feedback,
        }));
        if (action.action === 'retry') {
          validationRetriesUsed += 1;
          validationFeedback = feedback;
          logFn(`plan-task stage=${state} verdict=${verdict} -> ${PLAN_TASK_TERMINAL} format validation RED (${validation.findings.length} finding(s)) — PLAN へ差し戻して再試行 (${validationRetriesUsed}/${DRIVER_CONFIG.maxPlanChildrenValidationRetries})`);
          state = PLAN_TASK_STAGES[0];
          continue;
        }
        escalate(issueNumber, PLAN_TASK_TERMINAL, verdict, `${action.reason}\n\n${feedback}`);
        logFn(`plan-task stage=${state} verdict=${verdict} -> ${PLAN_TASK_TERMINAL} format validation RED again — ${action.reason}`);
        state = 'ESCALATE';
        break;
      }
    }

    if (next === 'ESCALATE') escalate(issueNumber, state, verdict, envelope.result ?? '');
    logFn(`plan-task stage=${state} verdict=${verdict} -> next=${next}`);
    state = next;
  }

  if (state === 'ESCALATE') dieFn(`plan-task escalated — see the escalation label + report comment on issue #${issueNumber}`);
  if (state === 'ASK_PDM') return completeAskPdm(issueNumber, planText, deps);
  if (state === PLAN_TASK_TERMINAL) return completeFileChildren(issueNumber, planText, deps);
  return 0;
}
