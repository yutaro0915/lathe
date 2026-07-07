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

function die(msg) { process.stderr.write(`inner-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[inner-loop] ${msg}\n`); }

// --- Pure / testable exports ---

function stripVerdictLine(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => !/^VERDICT:\s*[A-Z_]+\s*$/.test(line)).join('\n').trim();
}

function firstMatchingLine(text, pattern) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Validate a plan-task child block's `Blocked-by:` value. A missing or empty
 * line is a parser failure, not "no deps" — silently rounding "absent" down
 * to "no deps" would file child issues with unverified dependency claims.
 * Blocks with no real dependency must say so explicitly with `none`.
 * @param {string | null} rawValue - the captured value after "Blocked-by:",
 *   or null if the line itself was not found in the block.
 * @returns {{ ok: true, blockedBy: string } | { ok: false, error: string }}
 */
export function parseBlockedByLine(rawValue) {
  if (rawValue == null) {
    return { ok: false, error: 'plan block is missing required "Blocked-by:" line (use "Blocked-by: none" if there are no dependencies)' };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'plan block has an empty "Blocked-by:" value (use "Blocked-by: none" if there are no dependencies)' };
  }
  if (/^none$/i.test(trimmed)) {
    return { ok: true, blockedBy: '' };
  }
  return { ok: true, blockedBy: trimmed };
}

function parseRejectedCandidateLine(line) {
  const match = String(line ?? '').match(/^\s*(?:[-*]\s*)?Rejected\s*:\s*(.+?)\s+(?:—|-)\s+(.+?)\s*$/i);
  if (!match) return null;
  return { candidate: match[1].trim(), reason: match[2].trim() };
}

/**
 * Parse the plan-task PLAN result into child issue blocks. Each block starts
 * with a `Title:` line and must carry `Blocked-by:` and `Touches:` machine
 * lines; `Rejected: <candidate> — <reason>` lines record dropped candidates.
 * @param {string} planText
 * @returns {{ ok: true, children: Array<{ index: number, title: string, blockedBy: string, touches: string, plan: string }>, rejected: Array<{candidate: string, reason: string}> } | { ok: false, error: string }}
 */
export function parsePlanChildBlocks(planText) {
  const rejected = [];
  const blockLines = [];
  let currentBlock = null;

  for (const line of String(planText ?? '').split(/\r?\n/)) {
    if (/^VERDICT:\s*[A-Z_]+\s*$/.test(line.trim())) continue;

    const rejectedCandidate = parseRejectedCandidateLine(line);
    if (rejectedCandidate) {
      rejected.push(rejectedCandidate);
      continue;
    }

    if (/^\s*Title\s*:\s*.+$/i.test(line)) {
      if (currentBlock) blockLines.push(currentBlock);
      currentBlock = [line];
      continue;
    }

    if (currentBlock) currentBlock.push(line);
  }

  if (currentBlock) blockLines.push(currentBlock);
  if (blockLines.length === 0) {
    return { ok: false, error: 'plan is missing required "Title:" line' };
  }

  const children = [];
  for (const [zeroBasedIndex, lines] of blockLines.entries()) {
    const index = zeroBasedIndex + 1;
    const blockText = lines.join('\n').trim();
    const title = firstMatchingLine(blockText, /^\s*Title\s*:\s*(.+)$/i);
    if (!title) {
      return { ok: false, error: `plan block ${index} is missing required "Title:" line` };
    }
    const blockedByRaw = firstMatchingLine(blockText, /^\s*Blocked-by\s*:\s*(.*)$/i);
    const blockedByResult = parseBlockedByLine(blockedByRaw);
    if (!blockedByResult.ok) {
      return { ok: false, error: `plan block ${index}: ${blockedByResult.error}` };
    }
    const touches = firstMatchingLine(blockText, /^\s*Touches\s*:\s*(.*)$/i);
    if (touches == null) {
      return { ok: false, error: `plan block ${index} is missing required "Touches:" line` };
    }
    children.push({
      index,
      title,
      blockedBy: blockedByResult.blockedBy,
      touches,
      plan: stripVerdictLine(blockText),
    });
  }

  return { ok: true, children, rejected };
}

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

function completeFileChildren(issueNumber, planText) {
  const created = createChildIssues(issueNumber, planText);
  if (!created.ok) {
    escalatePlanTask(issueNumber, PLAN_TASK_TERMINAL, null, created.error);
    die(`plan-task child issue filing failed — see the escalation report comment on issue #${issueNumber}`);
  }
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: PLAN_TASK_TERMINAL,
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: created.children.map((child) => `created plan#${child.index} -> #${child.issueNumber}: ${child.title}`).join('\n'),
  }));
  log(`plan-task filed ${created.children.length} child issue(s): ${created.children.map((child) => `#${child.issueNumber}`).join(', ')}`);

  const comment = buildPlanTaskCloseComment({
    children: created.children,
    rejected: created.rejected,
    planText,
  });
  const r = spawnSync('gh', ['issue', 'close', String(issueNumber), '--reason', 'completed', '--comment', comment], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    escalatePlanTask(issueNumber, 'CLOSE_SOURCE', null, `gh issue close failed\n\n${tailLines(`${r.stdout ?? ''}${r.stderr ?? ''}`)}`);
    die(`plan-task source close failed — see the escalation report comment on issue #${issueNumber}`);
  }
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: 'CLOSE_SOURCE',
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: `closed source issue #${issueNumber}`,
  }));
  log(`plan-task done — plan confirmed, child issue(s) ${created.children.map((child) => `#${child.issueNumber}`).join(', ')} filed, source issue #${issueNumber} closed.`);
  return 0;
}

function completeAskPdm(issueNumber, resultText) {
  const body = buildAskPdmComment({ resultText });
  const r = spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) die(`gh issue comment failed for ASK_PDM terminal: ${r.stderr || r.stdout}`);
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: 'ASK_PDM',
    sessionId: null,
    verdict: 'ASK_PDM',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: body,
  }));
  log(`plan-task paused at PdM decision (正常終端) — options posted as a comment on issue #${issueNumber}; the issue stays open.`);
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
  log(`dry-run: ${PLAN_TASK_TERMINAL} — parse child blocks (Title/Blocked-by/Touches), gh issue create --label ${TASK_REQUEST_LABEL} per block (body carries blocked-by #${issueNumber} + resolved plan#<k> refs), then gh issue close ${issueNumber} --reason completed --comment '<confirmed plan + children>'`);
  log('dry-run: ASK_PDM — post the options as an issue comment and exit 0 with the source issue left open (正常終端)');
  log('dry-run: transition plan — PLAN_READY->FILE_CHILDREN, ASK_PDM->ASK_PDM (normal terminal), missing/unparsable VERDICT->same stage retry once then ESCALATE');
}

/**
 * Run a plan-task to one of its terminals. Returns a process exit code.
 * @param {number} issueNumber
 * @param {{ title: string, body: string, comments?: Array<object> }} issue
 * @param {{ global: string|null, stages: Record<string,string> }} backendFlags
 * @returns {number}
 */
export function runPlanTask(issueNumber, issue, backendFlags) {
  const planFormat = readPlanFormatOrDie();
  let state = PLAN_TASK_STAGES[0];
  let planText = '';

  while (PLAN_TASK_STAGES.includes(state)) {
    const prompt = buildStagePrompt(state, {
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      comments: issue.comments,
      planFormat,
    });
    const backend = selectBackend(state, backendFlags);
    log(`plan-task stage=${state} backend=${backend} cwd=${REPO_ROOT} — spawning ${backend}`);
    const stageResult = runStageWithUnparsableRetry({
      runAttempt: () => {
        const stageStartedAt = Date.now();
        const envelope = runStage(state, prompt, REPO_ROOT, null, backend);
        const durationMs = Math.max(1, Date.now() - stageStartedAt);
        return { envelope, durationMs };
      },
      recordAttempt: ({ envelope, manifestVerdict, durationMs }) => {
        appendPlanManifestEntry(issueNumber, buildManifestEntry({
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
      onRetry: () => log(`plan-task stage=${state} verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });
    const { envelope, verdict } = stageResult;

    if (verdict === null) {
      escalatePlanTask(issueNumber, state, UNPARSABLE_VERDICT, envelope.result ?? '');
      state = 'ESCALATE';
      break;
    }

    if (verdict === 'PLAN_READY' || verdict === 'ASK_PDM') planText = envelope.result;

    const { next } = nextPlanTaskState(state, verdict);
    if (next === 'ESCALATE') escalatePlanTask(issueNumber, state, verdict, envelope.result ?? '');
    log(`plan-task stage=${state} verdict=${verdict} -> next=${next}`);
    state = next;
  }

  if (state === 'ESCALATE') die(`plan-task escalated — see the escalation label + report comment on issue #${issueNumber}`);
  if (state === 'ASK_PDM') return completeAskPdm(issueNumber, planText);
  if (state === PLAN_TASK_TERMINAL) return completeFileChildren(issueNumber, planText);
  return 0;
}
