#!/usr/bin/env node
// CLI: node scripts/inner-loop.mjs <issue#> [--resume] [--dry-run] [--backend claude|codex]
//      node scripts/inner-loop.mjs --plan <issue#> [--dry-run] [--backend claude|codex]
//      [--backend-<stage> claude|codex]
// inner loop driver — code state machine driving headless named agents
// (planner/implementer/reviewer/verifier/test-triage) through
// PLAN → IMPLEMENT → REVIEW → VERIFY → (RED→TRIAGE) → MERGE for one issue.
// plan-loop mode drives RESEARCH → PLAN → PLAN-REVIEW → issue create → close.
// ADR 0013 (adr/0013-inner-loop-driver.md) / ADR 0014 (backend adapter).
//
// Pure logic is exported for unit testing. Side-effect helpers stay private
// unless a narrow fake injection point is needed by tests. Backend pure
// functions live in inner-loop-backends.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { buildStagePrompt } from './inner-loop-prompts.mjs';
import {
  stagePermissions, stageCwd, buildReceiptArgs,
  stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt,
  parseCodexSessionId, parseCodexCostUsd, parseCodexCostReport, parseBackendFlags, selectBackend,
  detectMainDirty, parseDependsOnLine,
} from './inner-loop-backends.mjs';

// Re-export stage helpers so existing tests importing from this file keep working.
export { stagePermissions, stageCwd, buildReceiptArgs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Constants ---

export const VALID_VERDICT_TOKENS = [
  'PLAN_READY', 'ESCALATE', 'IMPL_DONE', 'PASS', 'CHANGES',
  'GREEN', 'RED', 'KNOWN', 'NOVEL',
];
export const UNPARSABLE_VERDICT = 'UNPARSABLE';
export const MAX_UNPARSABLE_STAGE_RETRIES = 1;

// Bounded retries: review⇄implement (CHANGES) and triage⇄implement (KNOWN)
// share one cycle counter — "review⇄implement は 2 周まで" (ADR 0013 §1).
export const MAX_CYCLES = 2;

export const APPROVED_PLAN_HEADING = '## Plan (approved)';
export const IMPL_LOOP_STAGES = ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE'];
export const IMPL_LOOP_STAGES_AFTER_PLAN = ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE'];
export const PLAN_LOOP_STAGES = ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'GATE', 'ISSUE_CREATE', 'CLOSE_SOURCE'];
export const WORKTREE_DEPS_INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline'];
const TOUCHES_GROUNDING_REPORT_ARGS = ['-C', 'apps/web', 'exec', 'tsx', 'scripts/touches-grounding.ts', '--format', 'json'];
const TOUCHES_GROUNDING_DRY_RUN_PLACEHOLDER = '<touches grounding JSON from pnpm -C apps/web exec tsx scripts/touches-grounding.ts --format json when status ok; omitted otherwise>';
const AUTO_OK_LABEL = 'auto-ok';
const PENDING_APPROVAL_LABEL = 'pending-approval';
const PLAN_APPROVED_LABEL = 'plan-approved';
const PLAN_GATE_LABELS = [PENDING_APPROVAL_LABEL, PLAN_APPROVED_LABEL, AUTO_OK_LABEL];

export function displayStage(stage) {
  return stage === 'PLAN_REVIEW' ? 'PLAN-REVIEW' : stage;
}

// --- Pure / testable exports ---

/**
 * Parse the VERDICT token from a stage's result text (last `VERDICT: <TOKEN>`
 * line wins). Returns null if absent/unparsable.
 * @param {string} resultText
 * @returns {string | null}
 */
export function parseVerdict(resultText) {
  if (!resultText || typeof resultText !== 'string') return null;
  const matches = [...resultText.matchAll(/VERDICT:\s*([A-Z_]+)/g)];
  if (matches.length === 0) return null;
  const token = matches[matches.length - 1][1];
  return VALID_VERDICT_TOKENS.includes(token) ? token : null;
}

export function isUnparsableManifestVerdict(verdict) {
  return verdict === UNPARSABLE_VERDICT;
}

/**
 * Run one stage attempt, recording every attempt, and retry once when the
 * result has no parseable VERDICT. The retry is a fresh backend invocation.
 * @param {{ runAttempt: Function, recordAttempt: Function, onRetry?: Function, maxRetries?: number }} p
 * @returns {object & { verdict: string|null, manifestVerdict: string }}
 */
export function runStageWithUnparsableRetry({
  runAttempt,
  recordAttempt,
  onRetry,
  maxRetries = MAX_UNPARSABLE_STAGE_RETRIES,
} = {}) {
  if (typeof runAttempt !== 'function') throw new TypeError('runAttempt is required');
  if (typeof recordAttempt !== 'function') throw new TypeError('recordAttempt is required');

  let unparsableRetries = 0;
  while (true) {
    const attempt = runAttempt();
    const envelope = attempt?.envelope ?? {};
    const verdict = parseVerdict(envelope.result);
    const manifestVerdict = verdict ?? UNPARSABLE_VERDICT;
    recordAttempt({ ...attempt, envelope, verdict, manifestVerdict, unparsableRetries });

    if (verdict !== null) return { ...attempt, envelope, verdict, manifestVerdict };
    if (unparsableRetries >= maxRetries) return { ...attempt, envelope, verdict: null, manifestVerdict };

    unparsableRetries += 1;
    onRetry?.({ retriesUsed: unparsableRetries, nextAttempt: unparsableRetries + 1 });
  }
}

// Last `n` lines of `text` (default 30), for surfacing real error output in
// an escalation excerpt instead of just "failed".
export function tailLines(text, n = 30) {
  return (text ?? '').trim().split('\n').slice(-n).join('\n');
}

/**
 * Detect the approved plan marker ADR 0016 uses to make impl-loop skip PLAN.
 * The marker is deliberately strict: a top-level line exactly matching
 * "## Plan (approved)" with optional trailing whitespace.
 * @param {string | null | undefined} body
 * @returns {boolean}
 */
export function hasApprovedPlanMarker(body) {
  if (typeof body !== 'string') return false;
  return body.split(/\r?\n/).some((line) => /^## Plan \(approved\)\s*$/.test(line));
}

/**
 * Extract the approved plan body after "## Plan (approved)" through EOF.
 * Returns an empty string when the marker is missing.
 * @param {string | null | undefined} body
 * @returns {string}
 */
export function extractApprovedPlan(body) {
  if (typeof body !== 'string') return '';
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Plan \(approved\)\s*$/.test(line));
  if (start < 0) return '';
  return lines.slice(start + 1).join('\n').trim();
}

/**
 * Select the loop/stage plan for an issue body.
 * @param {{ mode?: 'impl'|'plan', issueBody?: string|null }} p
 */
export function selectRunPlan({ mode = 'impl', issueBody = '' } = {}) {
  if (mode === 'plan') {
    return {
      mode: 'plan',
      manifestPrefix: 'plan',
      stages: [...PLAN_LOOP_STAGES],
      initialState: 'RESEARCH',
      skipPlan: false,
      approvedPlan: '',
    };
  }

  const approvedPlan = extractApprovedPlan(issueBody);
  const skipPlan = hasApprovedPlanMarker(issueBody);
  return {
    mode: 'impl',
    manifestPrefix: 'issue',
    stages: skipPlan ? [...IMPL_LOOP_STAGES_AFTER_PLAN] : [...IMPL_LOOP_STAGES],
    initialState: skipPlan ? 'IMPLEMENT' : 'PLAN',
    skipPlan,
    approvedPlan,
  };
}

// A Backlog.md task id: "TASK-<n>" or "TASK-<n>.<m>" (ADR 0025 §4 / TASK-1.1
// taskUnitToSlug convention). Case-insensitive on input; the id is kept as
// typed (not upper-cased) so it round-trips into `backlog task view <id>`.
const TASK_ID_RE = /^TASK-\d+(?:\.\d+)*$/i;

/**
 * Parse driver flags while preserving backend flag handling in
 * inner-loop-backends.mjs.
 *
 * impl mode accepts either a GitHub issue number (legacy, backward compatible)
 * or a Backlog.md task id via `--task <ID>` or a bare `TASK-<n>` positional
 * argument (ADR 0025 §4 / TASK-1.2). plan-loop (`--plan`) is unaffected and
 * keeps taking a GitHub issue number only (TASK-1.3 scope).
 * @param {string[]} argv
 * @returns {{ mode: 'impl'|'plan', issueNumber: number|null, unit: { kind: 'issue'|'task', id: number|string }|null, dryRun: boolean, resume: boolean, backendFlags: { global: string|null, stages: Record<string,string> }, error: string|null }}
 */
export function parseDriverArgs(argv) {
  let mode = 'impl';
  let issueArg = null;
  let taskArg = null;
  let dryRun = false;
  let resume = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--resume') {
      resume = true;
    } else if (arg === '--plan') {
      mode = 'plan';
      issueArg = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--plan=')) {
      mode = 'plan';
      issueArg = arg.slice('--plan='.length);
    } else if (arg === '--task') {
      taskArg = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--task=')) {
      taskArg = arg.slice('--task='.length);
    } else if (arg === '--backend' || /^--backend-[a-z-]+$/.test(arg)) {
      i += 1;
    } else if (arg.startsWith('--')) {
      return { mode, issueNumber: null, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unknown argument: ${arg}` };
    } else if (TASK_ID_RE.test(arg) && issueArg == null && taskArg == null) {
      taskArg = arg;
    } else if (issueArg == null && taskArg == null) {
      issueArg = arg;
    } else {
      return { mode, issueNumber: null, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unexpected positional argument: ${arg}` };
    }
  }

  if (taskArg != null) {
    if (mode === 'plan') {
      return { mode, issueNumber: null, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: 'plan-loop does not accept a task id (TASK-1.3 scope)' };
    }
    if (!TASK_ID_RE.test(taskArg)) {
      return { mode, issueNumber: null, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `invalid task id: ${taskArg}` };
    }
    return { mode, issueNumber: null, unit: { kind: 'task', id: taskArg }, dryRun, resume, backendFlags: parseBackendFlags(argv), error: null };
  }

  const issueNumber = Number(issueArg);
  if (!issueArg || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { mode, issueNumber: null, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: 'missing or invalid issue number' };
  }
  // unit stays null for the issue-number path: the rest of the driver's
  // "unit" parameter (manifestPathFor/worktreeNameFor/prompts) already treats
  // a plain number as the issue-loop case, so issueNumber itself IS the unit
  // identifier here — no wrapper object (ADR 0025 §4 / TASK-1.2).
  return { mode, issueNumber, unit: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: null };
}

/**
 * Detect the P4 playbook class: Codex sandbox EPERM is a non-implementable
 * environment/backend failure. If triage still returns KNOWN for it, the driver
 * must escalate instead of spending an IMPLEMENT cycle.
 * @param {string} resultText
 * @returns {boolean}
 */
export function isCodexSandboxEpermTriageResult(resultText) {
  if (!resultText || typeof resultText !== 'string') return false;
  const text = resultText.toLowerCase();
  if (!text.includes('eperm')) return false;
  if (/\bp4\b/.test(text)) return true;
  if (text.includes('codex sandbox')) return true;
  if (!text.includes('sandbox')) return false;
  return [
    '.tsbuildinfo',
    '.next',
    'playwright',
    '127.0.0.1',
    '::1',
    'localhost',
    'temp',
  ].some((marker) => text.includes(marker));
}

/**
 * State transition table. Returns next state and updated cycle count.
 * Terminal states: MERGE (driver runs merge.mjs), ESCALATE, DONE.
 * @param {string} state
 * @param {string | null} verdict
 * @param {number} cycles
 * @param {{ nonImplementableKnown?: boolean }} context
 * @returns {{ next: string, cycles: number }}
 */
export function nextState(state, verdict, cycles = 0, context = {}) {
  if (verdict === null) return { next: 'ESCALATE', cycles };
  switch (state) {
    case 'PLAN':
      return verdict === 'PLAN_READY' ? { next: 'IMPLEMENT', cycles } : { next: 'ESCALATE', cycles };
    case 'IMPLEMENT':
      return verdict === 'IMPL_DONE' ? { next: 'REVIEW', cycles } : { next: 'ESCALATE', cycles };
    case 'REVIEW':
      if (verdict === 'PASS') return { next: 'VERIFY', cycles };
      if (verdict === 'CHANGES') {
        const next = cycles + 1;
        return next > MAX_CYCLES ? { next: 'ESCALATE', cycles: next } : { next: 'IMPLEMENT', cycles: next };
      }
      return { next: 'ESCALATE', cycles };
    case 'VERIFY':
      if (verdict === 'GREEN') return { next: 'MERGE', cycles };
      if (verdict === 'RED') return { next: 'TRIAGE', cycles };
      return { next: 'ESCALATE', cycles };
    case 'TRIAGE':
      if (verdict === 'KNOWN') {
        if (context.nonImplementableKnown) return { next: 'ESCALATE', cycles };
        const next = cycles + 1;
        return next > MAX_CYCLES ? { next: 'ESCALATE', cycles: next } : { next: 'IMPLEMENT', cycles: next };
      }
      return { next: 'ESCALATE', cycles };
    default:
      return { next: 'ESCALATE', cycles };
  }
}

/**
 * Plan-loop transition table (ADR 0016).
 * Terminal/action states: ISSUE_CREATE, ESCALATE.
 * @param {string} state
 * @param {string | null} verdict
 * @param {number} cycles
 * @returns {{ next: string, cycles: number }}
 */
export function nextPlanLoopState(state, verdict, cycles = 0) {
  if (verdict === null) return { next: 'ESCALATE', cycles };
  switch (state) {
    case 'RESEARCH':
      return verdict === 'PASS' ? { next: 'PLAN', cycles } : { next: 'ESCALATE', cycles };
    case 'PLAN':
      return verdict === 'PLAN_READY' ? { next: 'PLAN_REVIEW', cycles } : { next: 'ESCALATE', cycles };
    case 'PLAN_REVIEW':
      if (verdict === 'PASS') return { next: 'GATE', cycles };
      if (verdict === 'CHANGES') {
        const next = cycles + 1;
        return next > MAX_CYCLES ? { next: 'ESCALATE', cycles: next } : { next: 'PLAN', cycles: next };
      }
      return { next: 'ESCALATE', cycles };
    case 'GATE':
      return verdict === 'PASS' ? { next: 'ISSUE_CREATE', cycles } : { next: 'ESCALATE', cycles };
    default:
      return { next: 'ESCALATE', cycles };
  }
}

/**
 * Build one run-manifest entry (ADR 0013 §2 + ADR 0014 backend field).
 * @param {{ stage: string, sessionId: string|null, verdict: string|null, backendCostUsd?: number|null, backendCostSource?: string|null, backendModel?: string|null, backendTokenUsage?: object|null, costUsd?: number|null, durationMs?: number|null, ts?: string, backend?: string|null, headSha?: string|null, resultText?: string|null, skipped?: boolean }} p
 */
export function buildManifestEntry({
  stage,
  sessionId,
  verdict,
  backendCostUsd,
  backendCostSource,
  backendModel,
  backendTokenUsage,
  costUsd,
  durationMs,
  ts,
  backend,
  headSha,
  resultText,
  skipped,
}) {
  const normalizedBackendCostUsd = backendCostUsd !== undefined ? backendCostUsd : costUsd;
  const entry = {
    stage,
    session_id: sessionId ?? null,
    verdict: verdict ?? null,
    backend_cost_usd: normalizedBackendCostUsd ?? null,
    backend_cost_source: backendCostSource ?? null,
    duration_ms: durationMs ?? null,
    ts: ts ?? new Date().toISOString(),
    backend: backend ?? null,
    head_sha: headSha ?? null,
    result_text: resultText ?? null,
  };
  if (backendModel != null) entry.backend_model = backendModel;
  if (backendTokenUsage != null) entry.backend_token_usage = backendTokenUsage;
  if (skipped === true) entry.skipped = true;
  return entry;
}

export function backendCostSourceForEnvelope(envelope) {
  if (typeof envelope?.backend_cost_source === 'string' && envelope.backend_cost_source) return envelope.backend_cost_source;
  if (envelope?.backend === 'claude') return 'claude.result.total_cost_usd';
  if (envelope?.backend === 'codex' && envelope.total_cost_usd != null) return 'codex.jsonl.explicit_cost';
  return null;
}

export function buildSkippedPlanEntry(approvedPlan) {
  return buildManifestEntry({
    stage: 'PLAN',
    sessionId: null,
    verdict: 'PLAN_READY',
    backendCostUsd: null,
    backendCostSource: null,
    durationMs: null,
    backend: null,
    headSha: null,
    resultText: approvedPlan ?? '',
    skipped: true,
  });
}

// Read existing manifest (if present), returning stages array or [].
export function readManifestStages(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.stages) ? data.stages : [];
  } catch { return []; }
}

const REVIEW_CONTRADICTION_MARKER_RE = /(矛盾|撤回|前言|contradict|withdraw)/i;

function clippedExcerpt(text, maxChars = 1200) {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) return value;
  return `...${value.slice(-maxChars)}`;
}

/**
 * Extract prior REVIEW results from a manifest so reviewer history travels
 * symmetrically across review cycles.
 * @param {object[]} stages
 * @returns {Array<{ ordinal: number, verdict: string|null, headSha: string|null, ts: string|null, excerpt: string, hasContradictionMarker: boolean }>}
 */
export function collectReviewHistory(stages) {
  if (!Array.isArray(stages)) return [];
  let ordinal = 0;
  return stages
    .filter((entry) => entry?.stage === 'REVIEW')
    .map((entry) => {
      ordinal += 1;
      const resultText = entry.result_text ?? '';
      return {
        ordinal,
        verdict: entry.verdict ?? null,
        headSha: entry.head_sha ?? null,
        ts: entry.ts ?? null,
        excerpt: clippedExcerpt(resultText),
        hasContradictionMarker: REVIEW_CONTRADICTION_MARKER_RE.test(String(resultText)),
      };
    });
}

function formatReviewHistoryEntries(history) {
  return history.map((entry) => [
    `### REVIEW #${entry.ordinal}`,
    `verdict: ${entry.verdict ?? '(none/unparsable)'}`,
    `head_sha: ${entry.headSha ?? '(none)'}`,
    `ts: ${entry.ts ?? '(none)'}`,
    `contradiction_marker: ${entry.hasContradictionMarker ? 'yes' : 'no'}`,
    '',
    '```',
    entry.excerpt,
    '```',
  ].join('\n')).join('\n\n');
}

/**
 * Build the REVIEW history block injected into second and later REVIEW prompts.
 * @param {object[]} stages
 * @returns {string}
 */
export function buildReviewHistorySummary(stages) {
  const history = collectReviewHistory(stages);
  if (history.length === 0) return '';
  return formatReviewHistoryEntries(history);
}

// Display label for the escalation heading: "issue #<n>" (unchanged, backward
// compatible) or "task <ID>" when issueNumber is a task unit ({ kind: 'task', id }).
function unitDisplayLabel(issueNumber) {
  return isTaskUnitLike(issueNumber) ? `task ${issueNumber.id}` : `issue #${issueNumber}`;
}

function isTaskUnitLike(value) {
  return Boolean(value && typeof value === 'object' && value.kind === 'task');
}

/**
 * Build escalation markdown with full REVIEW verdict history for outer recovery.
 * @param {{ issueNumber: number|{kind:'task',id:string}, stage: string, verdict: string|null, ts?: string, resultExcerpt?: string|null, reviewHistory?: Array<{ ordinal: number, verdict: string|null, headSha: string|null, ts: string|null, excerpt: string, hasContradictionMarker: boolean }> }} p
 * @returns {string}
 */
export function buildEscalationMarkdown({ issueNumber, stage, verdict, ts, resultExcerpt, reviewHistory = [] }) {
  const lines = [
    `# escalation — ${unitDisplayLabel(issueNumber)}`,
    '',
    `stage: ${stage}`,
    `verdict: ${verdict ?? '(none/unparsable)'}`,
    `ts: ${ts ?? new Date().toISOString()}`,
    '',
    '## REVIEW verdict history',
    '',
  ];
  if (Array.isArray(reviewHistory) && reviewHistory.length > 0) {
    lines.push(formatReviewHistoryEntries(reviewHistory));
  } else {
    lines.push('(no REVIEW entries recorded)');
  }
  lines.push(
    '',
    '## result excerpt',
    '',
    '```',
    clippedExcerpt(resultExcerpt, 4000),
    '```',
    '',
  );
  return lines.join('\n');
}

// Convert a Backlog.md task id (e.g. "TASK-1", "TASK-1.2") into a run_key
// slug (e.g. "task-1", "task-1-2"): lowercase, non-alphanumeric -> '-'
// (ADR 0025 §4 gap list / TASK-1.1 decision: run_key = task-<slug>).
export function taskUnitToSlug(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Build the full manifest object for writing.
// `issueNumber` keeps the existing issue-loop contract unchanged. Pass a
// task unit ({ kind: 'task', id }) via `extra.unit` to opt into the
// task-keyed manifest shape (`unit` field, no `issue` field) added in
// TASK-1.1 (ADR 0025 §4) — existing issue-loop callers are unaffected.
export function buildManifest(issueNumber, stages, extra = {}) {
  const { unit, ...rest } = extra;
  if (unit && unit.kind === 'task') {
    return { unit, ...rest, stages };
  }
  return { issue: issueNumber, ...extra, stages };
}

function requiresResultText(stage, verdict) {
  return (
    (stage === 'PLAN' && verdict === 'PLAN_READY') ||
    (stage === 'REVIEW' && verdict === 'CHANGES') ||
    (stage === 'VERIFY' && verdict === 'RED') ||
    (stage === 'TRIAGE' && verdict === 'KNOWN') ||
    verdict === 'ESCALATE' ||
    verdict === UNPARSABLE_VERDICT ||
    verdict === null
  );
}

function isWorktreeStage(stage) {
  return ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE'].includes(stage);
}

export function stageRequiresFreshMainRebase(stage) {
  return stage === 'IMPLEMENT' || stage === 'REVIEW';
}

/**
 * Decide where a manifest-backed inner-loop run can resume.
 * @param {{ stages: object[], worktree: { exists: boolean, branchMatches: boolean, clean: boolean, headSha: string|null } }} p
 * @returns {{ ok: true, state: string, cycles: number, plan: string, feedback: string|null, verifyResult: string, headSha: string|null, skipped: string[], receiptsToStamp: Array<{stage: string, headSha: string, verdict: string}> } | { ok: false, reason: string }}
 */
export function decideResumeState({ stages, worktree }) {
  if (!Array.isArray(stages) || stages.length === 0) return { ok: false, reason: 'missing manifest or manifest has no stages' };
  if (!worktree?.exists) return { ok: false, reason: 'missing worktree' };
  if (!worktree.branchMatches) return { ok: false, reason: 'worktree branch mismatch' };
  if (!worktree.clean) return { ok: false, reason: 'dirty worktree' };
  if (!worktree.headSha) return { ok: false, reason: 'could not determine worktree HEAD sha' };

  let state = 'PLAN';
  let cycles = 0;
  let plan = '';
  let feedback = null;
  let verifyResult = '';
  let expectedHeadSha = null;
  const skipped = [];
  const receiptsToStamp = [];
  let unparsableAttemptsForState = 0;
  const shaMismatch = () => (
    expectedHeadSha && worktree.headSha !== expectedHeadSha
      ? { ok: false, reason: `sha mismatch: manifest head_sha=${expectedHeadSha} worktree HEAD=${worktree.headSha}` }
      : null
  );

  for (const entry of stages) {
    if (!entry || entry.stage !== state) {
      return { ok: false, reason: `manifest stage order mismatch: expected ${state}, got ${entry?.stage ?? '(missing)'}` };
    }

    const verdict = entry.verdict ?? null;
    if (requiresResultText(entry.stage, verdict) && typeof entry.result_text !== 'string') {
      return { ok: false, reason: `legacy manifest lacks result_text for ${entry.stage}=${verdict ?? '(none)'}` };
    }
    if (isWorktreeStage(entry.stage)) {
      if (typeof entry.head_sha !== 'string' || entry.head_sha.length === 0) {
        return { ok: false, reason: `legacy manifest lacks head_sha for ${entry.stage}` };
      }
      expectedHeadSha = entry.head_sha;
    }

    if (verdict === 'ESCALATE' || verdict === null) {
      const mismatch = shaMismatch();
      if (mismatch) return mismatch;
      return {
        ok: true,
        state: entry.stage,
        cycles,
        plan,
        feedback,
        verifyResult,
        headSha: worktree.headSha,
        skipped,
        receiptsToStamp,
      };
    }

    if (isUnparsableManifestVerdict(verdict)) {
      unparsableAttemptsForState += 1;
      if (unparsableAttemptsForState > MAX_UNPARSABLE_STAGE_RETRIES) {
        return { ok: false, reason: `unparsable retry exhausted for ${entry.stage}` };
      }
      continue;
    }
    unparsableAttemptsForState = 0;

    if (entry.stage === 'PLAN' && verdict === 'PLAN_READY') plan = entry.result_text;
    if (entry.stage === 'REVIEW' && verdict === 'CHANGES') feedback = entry.result_text;
    if (entry.stage === 'VERIFY' && verdict === 'RED') verifyResult = entry.result_text;
    const nonImplementableKnown =
      entry.stage === 'TRIAGE' && verdict === 'KNOWN' && isCodexSandboxEpermTriageResult(entry.result_text);
    if (entry.stage === 'TRIAGE' && verdict === 'KNOWN' && !nonImplementableKnown) feedback = entry.result_text;

    const receipt = buildReceiptArgs(entry.stage, entry.head_sha, verdict);
    if (receipt) receiptsToStamp.push({ stage: entry.stage, headSha: entry.head_sha, verdict });

    const next = nextState(entry.stage, verdict, cycles, { nonImplementableKnown });
    if (next.next === 'ESCALATE') {
      const mismatch = shaMismatch();
      if (mismatch) return mismatch;
      return {
        ok: true,
        state: entry.stage,
        cycles,
        plan,
        feedback,
        verifyResult,
        headSha: worktree.headSha,
        skipped,
        receiptsToStamp,
      };
    }
    skipped.push(entry.stage);
    state = next.next;
    cycles = next.cycles;
  }

  if (expectedHeadSha && worktree.headSha !== expectedHeadSha) {
    return { ok: false, reason: `sha mismatch: manifest head_sha=${expectedHeadSha} worktree HEAD=${worktree.headSha}` };
  }

  return {
    ok: true,
    state,
    cycles,
    plan,
    feedback,
    verifyResult,
    headSha: worktree.headSha,
    skipped,
    receiptsToStamp,
  };
}

// Also export backend pure functions so tests can import from one place.
export {
  stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt,
  parseCodexSessionId, parseCodexCostUsd, parseCodexCostReport, parseBackendFlags, selectBackend,
  detectMainDirty,
};

// --- Side-effectful helpers ---

function die(msg) { process.stderr.write(`inner-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[inner-loop] ${msg}\n`); }

export function setupWorktreeDeps(worktreePath, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const writeLog = deps.log ?? log;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  try {
    const result = run('pnpm', WORKTREE_DEPS_INSTALL_ARGS, { cwd: worktreePath, stdio: 'inherit' });
    const durationMs = Math.max(1, now() - startedAt);
    const status = typeof result?.status === 'number' ? result.status : null;
    const error = result?.error ? (result.error.message ?? String(result.error)) : null;

    if (status === 0) {
      writeLog(`worktree deps setup succeeded: pnpm ${WORKTREE_DEPS_INSTALL_ARGS.join(' ')} cwd=${worktreePath} elapsed=${durationMs}ms`);
      return { ok: true, status, error: null, durationMs };
    }

    writeLog(
      `warning: worktree deps setup failed: pnpm ${WORKTREE_DEPS_INSTALL_ARGS.join(' ')} ` +
      `cwd=${worktreePath} status=${status ?? 'null'} error=${error ?? 'null'} ` +
      `elapsed=${durationMs}ms; continuing with P3 fallback`,
    );
    return { ok: false, status, error, durationMs };
  } catch (error) {
    const durationMs = Math.max(1, now() - startedAt);
    const message = error?.message ?? String(error);
    writeLog(
      `warning: worktree deps setup failed: pnpm ${WORKTREE_DEPS_INSTALL_ARGS.join(' ')} ` +
      `cwd=${worktreePath} status=null error=${message} elapsed=${durationMs}ms; continuing with P3 fallback`,
    );
    return { ok: false, status: null, error: message, durationMs };
  }
}

function fetchIssue(issueNumber) {
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) die(`gh issue view failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout); } catch (e) { die(`could not parse gh issue view output: ${e.message}`); }
}

// backlog CLI path — repo-local devDependency binary (ADR 0025 PLAN-gate
// decision #4: "driver は node_modules/.bin/backlog 直呼び／pnpm 層回避").
// LATHE_FAKE_BACKLOG_BIN lets CLI-level tests (spawning this file as a real
// subprocess, e.g. plan-loop's ISSUE_CREATE) point at a fake bin — the
// absolute node_modules/.bin path is not shadowable via PATH like `gh` is.
const BACKLOG_BIN = process.env.LATHE_FAKE_BACKLOG_BIN || join(REPO_ROOT, 'node_modules', '.bin', 'backlog');

const TASK_VIEW_SECTION_HEADINGS = [
  'Description',
  'Acceptance Criteria',
  'Definition of Done',
  'Implementation Plan',
  'Implementation Notes',
];

/**
 * Parse `backlog task view <id> --plain` output into an issue-shaped object
 * ({ title, body, status, labels, dependencies }) so the rest of the driver
 * (worktree naming, manifest, prompts) can keep treating "the unit" uniformly.
 * Pure — takes the CLI's stdout text, returns a plain object. Unknown/absent
 * sections are tolerated (e.g. "No Definition of Done items defined").
 * @param {string} text
 * @returns {{ title: string|null, body: string, status: string|null, labels: string[], dependencies: string[] }}
 */
export function parseTaskViewPlain(text) {
  const lines = String(text ?? '').split(/\r?\n/);

  let title = null;
  const titleLineIndex = lines.findIndex((line) => /^Task\s+TASK-/.test(line));
  if (titleLineIndex >= 0) {
    const m = lines[titleLineIndex].match(/^Task\s+(TASK-[^\s]+)\s*-\s*(.+)$/);
    if (m) title = m[2].trim();
  }

  let status = null;
  const statusLine = lines.find((line) => /^Status:\s*/.test(line));
  if (statusLine) {
    // "Status: ○ To Do" / "Status: ● Done" — strip the leading bullet glyph.
    status = statusLine.replace(/^Status:\s*/, '').replace(/^[^\w]*\s*/, '').trim();
  }

  let labels = [];
  const labelsLine = lines.find((line) => /^Labels:\s*/.test(line));
  if (labelsLine) {
    labels = labelsLine.replace(/^Labels:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  let dependencies = [];
  const depsLine = lines.find((line) => /^Dependencies:\s*/.test(line));
  if (depsLine) {
    dependencies = depsLine.replace(/^Dependencies:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Reassemble "Description" + "Acceptance Criteria" + "Implementation Plan"
  // + "Implementation Notes" (skip "Definition of Done" — driver/merge concern,
  // not implementer input) into one body blob, each under its own heading, the
  // same way an issue body carries free-form markdown.
  const sections = {};
  let currentHeading = null;
  let currentLines = [];
  const flush = () => {
    if (currentHeading) sections[currentHeading] = currentLines.join('\n').trim();
    currentLines = [];
  };
  for (const line of lines) {
    const headingMatch = TASK_VIEW_SECTION_HEADINGS.find((h) => line === `${h}:`);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch;
      continue;
    }
    if (currentHeading) {
      if (/^-{5,}$/.test(line.trim())) continue; // section underline
      currentLines.push(line);
    }
  }
  flush();

  const bodyParts = [];
  for (const heading of ['Description', 'Acceptance Criteria', 'Implementation Plan', 'Implementation Notes']) {
    const content = sections[heading];
    if (content) bodyParts.push(`## ${heading}\n\n${content}`);
  }

  return { title, body: bodyParts.join('\n\n'), status, labels, dependencies };
}

/**
 * Fetch a Backlog.md task via `backlog task view <id> --plain` and normalize
 * it into the same issue-shaped object fetchIssue returns (ADR 0025 §4 /
 * TASK-1.2 AC#2). Dies on CLI failure, matching fetchIssue's contract.
 * @param {string} id
 * @returns {{ title: string|null, body: string, status: string|null, labels: string[], dependencies: string[] }}
 */
function fetchTask(id) {
  const r = spawnSync(BACKLOG_BIN, ['task', 'view', id, '--plain'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) die(`backlog task view failed: ${r.stderr || r.stdout}`);
  return parseTaskViewPlain(r.stdout);
}

/**
 * Fetch "the unit" (a GitHub issue or a Backlog.md task) into the shared
 * issue-shaped shape the rest of the driver consumes. `unit` is
 * { kind: 'issue', id: number } | { kind: 'task', id: string }.
 * @param {{ kind: 'issue'|'task', id: number|string }} unit
 */
function fetchUnit(unit) {
  return unit.kind === 'task' ? fetchTask(unit.id) : fetchIssue(unit.id);
}

export function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) return [];
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && name.length > 0);
}

export function issueHasLabel(issue, labelName) {
  const wanted = String(labelName ?? '').toLowerCase();
  return issueLabelNames(issue).some((name) => name.toLowerCase() === wanted);
}

function ensureGithubLabel(labelName) {
  const r = spawnSync('gh', ['label', 'create', labelName, '--force'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`gh label create failed for ${labelName}: ${r.stderr || r.stdout}`);
}

function ensurePlanGateLabels() {
  for (const labelName of PLAN_GATE_LABELS) ensureGithubLabel(labelName);
}

export function buildPlanApprovalRequestComment({ issueNumber, approvedPlan }) {
  return [
    'plan-loop is paused before creating implementation issues.',
    '',
    '## approved plan',
    '',
    String(approvedPlan ?? '').trim(),
    '',
    '## approval',
    '',
    `承認するには \`${PLAN_APPROVED_LABEL}\` ラベルを付与し \`node scripts/inner-loop.mjs --plan ${issueNumber} --resume\` を実行してください。`,
    '',
  ].join('\n');
}

function postPlanApprovalRequest(issueNumber, approvedPlan) {
  const body = buildPlanApprovalRequestComment({ issueNumber, approvedPlan });
  const r = spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) die(`gh issue comment failed for plan approval gate: ${r.stderr || r.stdout}`);
  return body;
}

function addIssueLabel(issueNumber, labelName) {
  const r = spawnSync('gh', ['issue', 'edit', String(issueNumber), '--add-label', labelName], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`gh issue edit --add-label failed for ${labelName}: ${r.stderr || r.stdout}`);
}

export function resolvePendingPlanGate(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { ok: false, reason: 'missing manifest or manifest has no stages' };
  }
  const last = stages.at(-1);
  if (last?.stage !== 'GATE' || last?.verdict !== 'PENDING_APPROVAL') {
    return { ok: false, reason: 'manifest tail is not GATE:PENDING_APPROVAL' };
  }
  const approvedPlanEntry = [...stages]
    .reverse()
    .find((entry) => entry?.stage === 'PLAN' && entry?.verdict === 'PLAN_READY' && typeof entry?.result_text === 'string');
  if (!approvedPlanEntry) {
    return { ok: false, reason: 'manifest lacks approved PLAN result_text before pending gate' };
  }
  return { ok: true, approvedPlan: approvedPlanEntry.result_text };
}

export function collectTouchesGroundingReport(deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('pnpm', TOUCHES_GROUNDING_REPORT_ARGS, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1e8 });
  if (r.status !== 0) return null;

  const stdout = (r.stdout ?? '').trim();
  if (!stdout) return null;

  try {
    const report = JSON.parse(stdout);
    return report?.status === 'ok' ? stdout : null;
  } catch {
    return null;
  }
}

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

export function parseApprovedPlanForIssue(planText) {
  const title = firstMatchingLine(planText, /^\s*Title\s*:\s*(.+)$/i);
  const dependsOn = firstMatchingLine(planText, /^\s*Depends-on\s*:\s*(.*)$/i);
  const touches = firstMatchingLine(planText, /^\s*Touches\s*:\s*(.*)$/i);
  return { title, dependsOn, touches };
}

function parseRejectedCandidateLine(line) {
  const match = String(line ?? '').match(/^\s*(?:[-*]\s*)?Rejected\s*:\s*(.+?)\s+(?:—|-)\s+(.+?)\s*$/i);
  if (!match) return null;
  return { candidate: match[1].trim(), reason: match[2].trim() };
}

export function parseApprovedPlanIssueBlocks(planText) {
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
    return { ok: false, error: 'approved plan is missing required "Title:" line' };
  }

  const issues = [];
  for (const [zeroBasedIndex, lines] of blockLines.entries()) {
    const index = zeroBasedIndex + 1;
    const blockText = lines.join('\n').trim();
    const parsed = parseApprovedPlanForIssue(blockText);
    if (!parsed.title) {
      return { ok: false, error: `approved plan block ${index} is missing required "Title:" line` };
    }
    const dependsOnResult = parseDependsOnLine(parsed.dependsOn);
    if (!dependsOnResult.ok) {
      return { ok: false, error: `approved plan block ${index}: ${dependsOnResult.error}` };
    }
    if (parsed.touches == null) {
      return { ok: false, error: `approved plan block ${index} is missing required "Touches:" line` };
    }
    issues.push({
      index,
      title: parsed.title,
      dependsOn: dependsOnResult.dependsOn,
      touches: parsed.touches,
      approvedPlan: stripVerdictLine(blockText),
    });
  }

  return { ok: true, issues, rejected };
}

export function resolvePlanTaskDependency(dependsOn, createdTaskIdsByPlanIndex) {
  const unresolved = [];
  const resolved = String(dependsOn ?? '').replace(/\bplan#(\d+)\b/gi, (token, rawIndex) => {
    const index = Number(rawIndex);
    const taskId = createdTaskIdsByPlanIndex.get(index);
    if (!taskId) {
      unresolved.push(token);
      return token;
    }
    return taskId;
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `unresolved plan-local dependency reference(s): ${unresolved.join(', ')}` };
  }
  return { ok: true, dependsOn: resolved };
}

function replaceApprovedPlanDependsOnLine(approvedPlan, dependsOn) {
  return String(approvedPlan ?? '').split(/\r?\n/).map((line) => {
    if (/^\s*Depends-on\s*:/i.test(line)) {
      return `Depends-on: ${dependsOn ?? ''}`;
    }
    return line;
  }).join('\n');
}

// Extract TASK-<n> tokens from a resolved Depends-on value for
// `backlog task create --depends-on` (ADR 0025 §4 / TASK-1.3). Only
// TASK-shaped tokens are forwarded — `backlog task create` hard-fails if any
// --depends-on id does not already exist, so a stray legacy GitHub issue
// reference (e.g. "#77", pre-dating ADR 0025) must not break task creation.
// Such tokens still ride along in the Description's Depends-on: line for a
// human to read; they are just not passed to the native dependency flag.
export function extractBacklogTaskDependencyIds(dependsOn) {
  const ids = [];
  const seen = new Set();
  for (const match of String(dependsOn ?? '').matchAll(/\bTASK-[^\s,]+/gi)) {
    const id = match[0].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function buildImplementationTaskDescription({ sourceIssueNumber, approvedPlan, dependsOn, touches }) {
  const normalizedApprovedPlan = replaceApprovedPlanDependsOnLine(stripVerdictLine(approvedPlan), dependsOn);
  return [
    `Generated from #${sourceIssueNumber}`,
    `Depends-on: ${dependsOn ?? ''}`,
    `Touches: ${touches ?? ''}`,
    '',
    APPROVED_PLAN_HEADING,
    normalizedApprovedPlan,
    '',
  ].join('\n');
}

// Parse the task id from `backlog task create --plain` stdout, e.g.
// "Task TASK-12 - some title\n==========...". Mirrors parseTaskViewPlain's
// title-line contract (TASK-1.2) so both entry points share the same shape.
export function parseBacklogCreatedTaskId(output) {
  const text = String(output ?? '');
  const match = text.match(/^Task\s+(TASK-[^\s]+)\s*-/m);
  return match ? match[1] : null;
}

export function createImplementationTasks(sourceIssueNumber, approvedPlan, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const parsedPlan = parseApprovedPlanIssueBlocks(approvedPlan);
  if (!parsedPlan.ok) {
    return { ok: false, error: parsedPlan.error };
  }

  const tasks = [];
  const createdTaskIdsByPlanIndex = new Map();
  for (const block of parsedPlan.issues) {
    const dependsOnResult = resolvePlanTaskDependency(block.dependsOn, createdTaskIdsByPlanIndex);
    if (!dependsOnResult.ok) {
      return { ok: false, error: `approved plan block ${block.index}: ${dependsOnResult.error}` };
    }
    const description = buildImplementationTaskDescription({
      sourceIssueNumber,
      approvedPlan: block.approvedPlan,
      dependsOn: dependsOnResult.dependsOn,
      touches: block.touches,
    });
    const backlogDependsOn = extractBacklogTaskDependencyIds(dependsOnResult.dependsOn);
    const args = ['task', 'create', block.title, '--description', description, '--labels', 'inner-loop', '--plain'];
    for (const depId of backlogDependsOn) args.push('--depends-on', depId);
    const r = run(BACKLOG_BIN, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      return { ok: false, error: `backlog task create failed for plan#${block.index}: ${r.stderr || r.stdout}` };
    }
    const taskId = parseBacklogCreatedTaskId(r.stdout);
    if (!taskId) {
      return { ok: false, error: `could not parse created task id from backlog output: ${r.stdout}` };
    }
    const created = {
      index: block.index,
      taskId,
      output: r.stdout.trim(),
      description,
      title: block.title,
    };
    tasks.push(created);
    createdTaskIdsByPlanIndex.set(block.index, taskId);
  }

  return { ok: true, tasks, rejected: parsedPlan.rejected };
}

export function buildPlanLoopCloseComment({ createdTasks, rejected }) {
  const lines = ['plan-loop created implementation tasks:', ''];
  for (const task of createdTasks) {
    lines.push(`- plan#${task.index} -> ${task.taskId}: ${task.title}`);
  }
  lines.push('', 'Rejected candidates:');
  if (rejected.length === 0) {
    lines.push('- none');
  } else {
    for (const candidate of rejected) {
      lines.push(`- ${candidate.candidate} — ${candidate.reason}`);
    }
  }
  return lines.join('\n');
}

function closeSourceIssue(sourceIssueNumber, created) {
  const comment = buildPlanLoopCloseComment({
    createdTasks: created.tasks,
    rejected: created.rejected,
  });
  const r = spawnSync('gh', ['issue', 'close', String(sourceIssueNumber), '--reason', 'completed', '--comment', comment], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Resolve worktree branch/path naming for either unit kind. `issueNumber`
// keeps the existing issue-loop contract (plain number -> inner-issue-<n>);
// pass a task unit ({ kind: 'task', id }) to opt into inner-task-<slug>
// naming (ADR 0025 §4 / TASK-1.2 AC#2).
export function worktreeNameFor(issueNumber) {
  if (issueNumber && typeof issueNumber === 'object' && issueNumber.kind === 'task') {
    // taskUnitToSlug already yields the run_key slug with a "task-" prefix
    // baked in (e.g. "TASK-1.2" -> "task-1-2", per manifestPathFor's
    // contract from TASK-1.1). Strip that prefix here so the worktree name
    // reads "inner-task-1-2" rather than "inner-task-task-1-2".
    const runKeySlug = taskUnitToSlug(issueNumber.id);
    const slug = runKeySlug.replace(/^task-/, '');
    return { branch: `inner/task-${slug}`, dirName: `inner-task-${slug}` };
  }
  return { branch: `inner/issue-${issueNumber}`, dirName: `inner-issue-${issueNumber}` };
}

export function prepareWorktree(issueNumber, deps = {}) {
  const { branch, dirName } = worktreeNameFor(issueNumber);
  const path = join(REPO_ROOT, '.claude', 'worktrees', dirName);
  const pathExists = deps.existsSync ?? existsSync;
  const run = deps.spawnSync ?? spawnSync;
  const setupDeps = deps.setupWorktreeDeps ?? setupWorktreeDeps;

  if (pathExists(path)) die(`worktree already exists at ${path} — refusing to overwrite. Remove it first if you intend to restart.`);
  const r = run('git', ['worktree', 'add', path, '-b', branch, 'main'], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.status !== 0) die(`git worktree add failed for ${path}`);
  setupDeps(path);
  return { path, branch };
}

function worktreeForIssue(issueNumber) {
  const { branch, dirName } = worktreeNameFor(issueNumber);
  return {
    branch,
    path: join(REPO_ROOT, '.claude', 'worktrees', dirName),
  };
}

function gitStdout(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function inspectResumeWorktree(issueNumber) {
  const { path, branch } = worktreeForIssue(issueNumber);
  if (!existsSync(path)) {
    return { exists: false, branchMatches: false, clean: false, headSha: null, path, branch };
  }
  const currentBranch = gitStdout(['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
  const headSha = gitStdout(['-C', path, 'rev-parse', 'HEAD'], REPO_ROOT);
  const status = gitStdout(['-C', path, 'status', '--porcelain'], REPO_ROOT);
  return {
    exists: true,
    branchMatches: currentBranch === branch,
    clean: status === '',
    headSha,
    path,
    branch,
  };
}

function resolveResumeState(issueNumber) {
  const p = manifestPathFor(issueNumber);
  if (!existsSync(p)) return { ok: false, reason: `missing manifest at ${p}` };
  const stages = readManifestStages(p);
  const worktree = inspectResumeWorktree(issueNumber);
  const decision = decideResumeState({ stages, worktree });
  if (!decision.ok) return decision;
  return { ...decision, worktreePath: worktree.path, branch: worktree.branch };
}

function dieResumeUnavailable(issueNumber, reason) {
  const restartArg = issueNumber && typeof issueNumber === 'object' && issueNumber.kind === 'task'
    ? issueNumber.id
    : issueNumber;
  die(
    `resume unavailable: ${reason}. ` +
    `Start from scratch by running without --resume: node scripts/inner-loop.mjs ${restartArg}. ` +
    'If a stale worktree/branch exists, remove it intentionally before restarting.',
  );
}

function stampReceiptOrDie(issueNumber, worktreePath, stamp) {
  const receipt = buildReceiptArgs(stamp.stage, stamp.headSha, stamp.verdict);
  if (!receipt) return;
  const rr = spawnSync(receipt.command, receipt.args, {
    cwd: worktreePath,
    env: { ...process.env, ...receipt.env },
    stdio: 'inherit',
  });
  if (rr.status !== 0) {
    writeEscalation(issueNumber, 'RESUME', stamp.verdict, `receipt.mjs failed: ${receipt.args.join(' ')}`);
    die(`resume receipt stamping failed — see .lathe/runs/issue-${issueNumber}.escalation.md`);
  }
}

function worktreeHeadShaOrDie(worktreePath, stage) {
  const head = gitStdout(['-C', worktreePath, 'rev-parse', 'HEAD'], REPO_ROOT);
  if (!head) die(`could not determine worktree HEAD after stage ${stage}`);
  return head;
}

// --- Stage runners (ADR 0014 backend adapters) ---

// Normalized envelope: { session_id, result, total_cost_usd, backend, ...backend evidence }
function runStageClaude(stage, prompt, cwd, resumeSessionId, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const args = buildClaudeArgs(stage, prompt, resumeSessionId);
  const r = run('claude', args, {
    encoding: 'utf8',
    cwd,
    maxBuffer: 1e8,
    env: { ...process.env, LATHE_STAGE: stage },
  });
  if (r.status !== 0 && !r.stdout) die(`claude -p failed for stage ${stage}: ${r.stderr || 'no output'}`);
  let env;
  try { env = JSON.parse(r.stdout); } catch (e) {
    die(`could not parse claude envelope for stage ${stage}: ${e.message}\nstdout: ${r.stdout}`);
  }
  return { session_id: env.session_id ?? null, result: env.result ?? '', total_cost_usd: env.total_cost_usd ?? null, backend: 'claude' };
}

function runStageCodex(stage, prompt, cwd, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const { agent } = stagePermissions(stage);
  const agentFile = join(REPO_ROOT, '.claude', 'agents', `${agent}.md`);
  const agentBody = existsSync(agentFile) ? stripFrontmatter(readFileSync(agentFile, 'utf8')) : '';
  const fullPrompt = buildCodexPrompt(agentBody, prompt);
  const lastmsgPath = join(tmpdir(), `lathe-inner-stage-${stage}.txt`);
  const args = buildCodexArgs(stage, fullPrompt, cwd, lastmsgPath, REPO_ROOT);
  const r = run('codex', ['exec', ...args], { encoding: 'utf8', cwd, maxBuffer: 1e8 });
  if (r.status !== 0 && !r.stdout) die(`codex exec failed for stage ${stage}: ${r.stderr || 'no output'}`);
  const sessionId = parseCodexSessionId(r.stdout ?? '');
  const costReport = parseCodexCostReport(r.stdout ?? '');
  const result = existsSync(lastmsgPath) ? readFileSync(lastmsgPath, 'utf8') : '';
  return {
    session_id: sessionId,
    result,
    total_cost_usd: costReport.costUsd,
    backend_cost_source: costReport.source,
    backend_model: costReport.model,
    backend_token_usage: costReport.tokenUsage,
    backend: 'codex',
  };
}

/**
 * Run one stage via the specified backend, returning a normalized envelope.
 * @param {string} stage
 * @param {string} prompt
 * @param {string} cwd
 * @param {string | null} resumeSessionId  (claude backend only)
 * @param {string} backend  'claude' | 'codex' (default 'claude')
 * @param {{ spawnSync?: Function }} deps
 * @returns {{ session_id: string|null, result: string, total_cost_usd: number|null, backend: string, backend_cost_source?: string|null, backend_model?: string|null, backend_token_usage?: object|null }}
 */
export function runStage(stage, prompt, cwd, resumeSessionId = null, backend = 'claude', deps = {}) {
  return backend === 'codex'
    ? runStageCodex(stage, prompt, cwd, deps)
    : runStageClaude(stage, prompt, cwd, resumeSessionId, deps);
}

// Resolve the run manifest path for an issue-loop run (existing contract,
// unchanged) or — when passed a task unit ({ kind: 'task', id }) — the
// task-keyed manifest path `.lathe/runs/task-<slug>.json` added in
// TASK-1.1 (ADR 0025 §4). Exported for unit testing; issue-loop call sites
// in this file keep passing a plain issueNumber.
export function manifestPathFor(issueNumber) {
  if (issueNumber && typeof issueNumber === 'object' && issueNumber.kind === 'task') {
    // taskUnitToSlug already yields the full run_key slug (e.g. "task-1",
    // "task-1-2") since task ids are conventionally "TASK-<n>" — do not
    // prepend another "task-" prefix here.
    return join(REPO_ROOT, '.lathe', 'runs', `${taskUnitToSlug(issueNumber.id)}.json`);
  }
  return join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.json`);
}

function planManifestPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `plan-${issueNumber}.json`);
}

function appendManifestEntry(issueNumber, entry) {
  const p = manifestPathFor(issueNumber);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildManifest(issueNumber, stages), null, 2) + '\n', 'utf8');
}

function appendPlanManifestEntry(issueNumber, entry) {
  const p = planManifestPathFor(issueNumber);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildManifest(issueNumber, stages, { mode: 'plan-loop' }), null, 2) + '\n', 'utf8');
}

// Escalation markdown path for a unit — mirrors manifestPathFor's naming
// (issue-<n>.escalation.md / task-<slug>.escalation.md).
function escalationPathFor(issueNumber) {
  return manifestPathFor(issueNumber).replace(/\.json$/, '.escalation.md');
}

function writeEscalation(issueNumber, stage, verdict, resultExcerpt) {
  const p = escalationPathFor(issueNumber);
  mkdirSync(dirname(p), { recursive: true });
  const reviewHistory = collectReviewHistory(readManifestStages(manifestPathFor(issueNumber)));
  appendFileSync(p, buildEscalationMarkdown({
    issueNumber,
    stage,
    verdict,
    resultExcerpt,
    reviewHistory,
  }), 'utf8');
  // Task-unit runs have no GitHub issue to comment on (ADR 0025 §4 impl-loop
  // rewire — gh dependency removed for the task path). Issue-loop runs keep
  // posting the gh issue comment unchanged (drain-in-place for in-flight runs).
  if (isTaskUnitLike(issueNumber)) {
    log(`escalation written for task ${issueNumber.id} — see ${p}`);
    return;
  }
  const cr = spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body',
    `inner-loop escalated at stage ${stage} (verdict: ${verdict ?? 'none'}). See ${p}`],
    { cwd: REPO_ROOT, stdio: 'inherit' });
  if (cr.status !== 0) log(`warning: gh issue comment failed (continuing) for issue #${issueNumber}`);
}

function writePlanEscalation(issueNumber, stage, verdict, resultExcerpt) {
  const p = join(REPO_ROOT, '.lathe', 'runs', `plan-${issueNumber}.escalation.md`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, [
    `# escalation — plan-loop issue #${issueNumber}`, '',
    `stage: ${displayStage(stage)}`, `verdict: ${verdict ?? '(none/unparsable)'}`, `ts: ${new Date().toISOString()}`, '',
    '## result excerpt', '', '```', (resultExcerpt ?? '').slice(-4000), '```', '',
  ].join('\n'), 'utf8');
  const cr = spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body',
    `plan-loop escalated at stage ${displayStage(stage)} (verdict: ${verdict ?? 'none'}). See ${p}`],
    { cwd: REPO_ROOT, stdio: 'inherit' });
  if (cr.status !== 0) log(`warning: gh issue comment failed (continuing) for source issue #${issueNumber}`);
}

export function rebaseWorktree(wt, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const result = run('git', ['-C', wt, 'rebase', 'main'], { stdio: 'inherit' });
  if (result.status === 0) return true;

  run('git', ['-C', wt, 'rebase', '--abort'], { stdio: 'inherit' });
  return false;
}

function runMerge(branch) {
  const r = spawnSync('node', ['scripts/merge.mjs', branch], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Mark a Backlog.md task Done in the worktree (CLI-only edit, no md hand-edit)
// and fold that edit into the branch as a NEW commit (not an amend of the
// reviewed/verified commit) — verify GREEN/review PASS already ran against
// the prior HEAD sha, and merge.mjs checks receipts against the exact branch
// tip sha (scripts/merge.mjs's checkReceipts), so amending would silently
// invalidate those receipts. The prior REVIEW/VERIFY receipts are re-stamped
// by the driver (not re-run) against the new tip: the code diff under review
// is unchanged, only a driver-owned task-bookkeeping commit was appended on
// top, which is exactly the kind of mechanical judgment ADR 0013's escalation
// contract reserves for the driver (agents don't adjudicate repo cleanliness).
export function markTaskDoneInWorktree(taskId, worktreePath, reviewedHeadSha, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const backlogBin = deps.backlogBin ?? BACKLOG_BIN;

  const r = run(backlogBin, ['task', 'edit', taskId, '--status', 'Done'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  if (r.status !== 0) return { ok: false, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };

  const add = run('git', ['-C', worktreePath, 'add', 'backlog/'], { encoding: 'utf8' });
  if (add.status !== 0) return { ok: false, output: `git add backlog/ failed: ${add.stderr || add.stdout}` };

  const status = run('git', ['-C', worktreePath, 'status', '--porcelain', '--', 'backlog/'], { encoding: 'utf8' });
  if ((status.stdout ?? '').trim() === '') return { ok: true, output: 'no backlog/ changes to commit (already Done?)', headSha: reviewedHeadSha };

  const commit = run('git', ['-C', worktreePath, 'commit', '-m', `backlog: ${taskId} -> Done`], { encoding: 'utf8' });
  if (commit.status !== 0) return { ok: false, output: `git commit failed: ${commit.stderr || commit.stdout}` };

  const headResult = run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const newHeadSha = headResult.status === 0 ? headResult.stdout.trim() : null;
  if (!newHeadSha) return { ok: false, output: 'could not determine worktree HEAD after status=Done commit' };

  // -z: NUL-terminated output. git never quotes/octal-escapes paths under -z,
  // unlike the default --name-only output which (with core.quotePath=true, the
  // default) wraps non-ASCII paths in double quotes with octal escapes — that
  // would make startsWith('backlog/') below false-reject legitimate backlog-only
  // Done commits whenever a task filename contains non-ASCII bytes (Japanese
  // text, em-dash, etc., which is the common case for this repo's task titles).
  const diffResult = run('git', ['-C', worktreePath, 'diff', '--name-only', '-z', `${reviewedHeadSha}..${newHeadSha}`], { encoding: 'utf8' });
  if (diffResult.status !== 0) return { ok: false, output: `git diff Done commit paths failed: ${diffResult.stderr || diffResult.stdout}` };
  const changedPaths = (diffResult.stdout ?? '').split('\0').map((line) => line.trim()).filter(Boolean);
  const nonBacklogPaths = changedPaths.filter((path) => !path.startsWith('backlog/'));
  if (nonBacklogPaths.length > 0) {
    return { ok: false, output: `Done commit contains non-backlog paths; refusing receipt re-stamp: ${nonBacklogPaths.join(', ')}` };
  }

  for (const step of ['review', 'verify']) {
    const rr = run('node', ['scripts/receipt.mjs', step, newHeadSha, step === 'review' ? 'PASS' : 'GREEN'], {
      cwd: worktreePath,
      env: { ...process.env, LATHE_AGENT: step === 'review' ? 'reviewer' : 'verifier' },
      encoding: 'utf8',
    });
    if (rr.status !== 0) return { ok: false, output: `receipt re-stamp (${step}) failed at ${newHeadSha}: ${rr.stderr || rr.stdout}` };
  }

  return { ok: true, output: `${r.stdout ?? ''}`, headSha: newHeadSha };
}

function cleanupWorktree(wt, branch) {
  spawnSync('git', ['worktree', 'remove', wt, '--force'], { cwd: REPO_ROOT, stdio: 'inherit' });
  spawnSync('git', ['branch', '-D', branch], { cwd: REPO_ROOT, stdio: 'inherit' });
}

function logDryRunStage(stage, backendFlags, cwd, promptPreview) {
  const backend = selectBackend(stage, backendFlags);
  const stageLabel = displayStage(stage);
  if (backend === 'codex') {
    const sb = stageSandbox(stage);
    const lm = join(tmpdir(), `lathe-inner-stage-${stage}.txt`);
    log(`dry-run: stage=${stageLabel} backend=codex sandbox=${sb} cwd=${cwd}`);
    const codexArgs = buildCodexArgs(stage, '<prompt>', cwd, lm, REPO_ROOT);
    log(`dry-run: codex exec ${codexArgs.join(' ')}`);
  } else {
    const { agent, permissionMode, allowedTools } = stagePermissions(stage);
    log(`dry-run: stage=${stageLabel} backend=claude agent=${agent} permission-mode=${permissionMode} allowedTools=${(allowedTools || []).join(',')} cwd=${cwd}`);
    log(`dry-run: claude -p '<prompt>' --agent ${agent} --output-format json --permission-mode ${permissionMode}`);
  }
  log(`dry-run: prompt preview:\n${promptPreview}\n`);
}

function dryRunPlanLoop(issueNumber, backendFlags) {
  log(`dry-run: plan-loop issue #${issueNumber}`);
  log(`dry-run: manifest ${planManifestPathFor(issueNumber)}`);
  log(`dry-run: would fetch source issue #${issueNumber} via gh issue view`);
  log(`dry-run: would collect touches grounding report via pnpm ${TOUCHES_GROUNDING_REPORT_ARGS.join(' ')}; unavailable/non-ok -> omit`);
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW']) {
    const promptPreview = buildStagePrompt(stage, {
      mode: 'plan-loop',
      issueNumber,
      issueTitle: '<title>',
      issueBody: '<body>',
      research: '<research>',
      plan: '<approved plan candidate>',
      feedback: '<plan-review feedback>',
      touchesGrounding: stage === 'RESEARCH' ? TOUCHES_GROUNDING_DRY_RUN_PLACEHOLDER : undefined,
    });
    logDryRunStage(stage, backendFlags, REPO_ROOT, promptPreview);
  }
  log(`dry-run: GATE — after PLAN-REVIEW PASS, refetch source issue labels: ${AUTO_OK_LABEL} present -> append GATE PASS and continue to ISSUE_CREATE`);
  log(`dry-run: GATE — ${AUTO_OK_LABEL} absent -> ensure labels ${PLAN_GATE_LABELS.join(', ')}, comment approved plan with resume command, add ${PENDING_APPROVAL_LABEL}, append GATE/PENDING_APPROVAL, exit 0`);
  log(`dry-run: resume — if manifest tail is GATE/PENDING_APPROVAL and source has ${PLAN_APPROVED_LABEL}, append GATE PASS and continue to ISSUE_CREATE; otherwise print approval pending and exit 2 without changes`);
  log('dry-run: ISSUE_CREATE — parse all approved issue blocks and run backlog task create --labels inner-loop --description <desc> [--depends-on TASK-<n> ...] --plain for each block');
  log(`dry-run: ISSUE_CREATE description per block includes Generated from #${issueNumber}, resolved Depends-on:, Touches:, ${APPROVED_PLAN_HEADING}`);
  log('dry-run: ISSUE_CREATE resolves plan#<k> dependencies to earlier created Backlog.md task ids (TASK-shaped deps forwarded to --depends-on; other tokens stay body-only)');
  log(`dry-run: CLOSE_SOURCE — gh issue close ${issueNumber} --reason completed --comment '<created task list and rejected candidates>'`);
  log('dry-run: transition plan — RESEARCH PASS->PLAN, PLAN_READY->PLAN-REVIEW, PLAN-REVIEW PASS->GATE, GATE PASS->ISSUE_CREATE / GATE PENDING_APPROVAL->exit 0 / CHANGES->PLAN (max 2 cycles), all backlog task create calls -> CLOSE_SOURCE, missing/unparsable VERDICT->same stage retry once then ESCALATE');
}

function completePlanLoopIssueCreate(issueNumber, approvedPlan) {
  const created = createImplementationTasks(issueNumber, approvedPlan);
  if (!created.ok) {
    writePlanEscalation(issueNumber, 'ISSUE_CREATE', null, created.error);
    die(`plan-loop issue create failed — see .lathe/runs/plan-${issueNumber}.escalation.md`);
  }
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: 'ISSUE_CREATE',
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: created.tasks.map((task) => `created plan#${task.index} -> ${task.taskId}\n${task.output}`).join('\n'),
  }));
  log(`plan-loop created ${created.tasks.length} implementation task(s): ${created.tasks.map((task) => task.taskId).join(', ')}`);

  const closeResult = closeSourceIssue(issueNumber, created);
  if (!closeResult.ok) {
    writePlanEscalation(issueNumber, 'CLOSE_SOURCE', null, `gh issue close failed\n\n${tailLines(closeResult.output)}`);
    die(`plan-loop source close failed — see .lathe/runs/plan-${issueNumber}.escalation.md`);
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
  log(`plan-loop done — created implementation task(s) ${created.tasks.map((task) => task.taskId).join(', ')} and closed source issue #${issueNumber}.`);
  return 0;
}

function appendPlanGatePass(issueNumber, resultText) {
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: 'GATE',
    sessionId: null,
    verdict: 'PASS',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText,
  }));
}

function handlePlanApprovalGate(issueNumber, issue, approvedPlan) {
  if (issueHasLabel(issue, AUTO_OK_LABEL)) {
    appendPlanGatePass(issueNumber, `${AUTO_OK_LABEL} label present on source issue #${issueNumber}`);
    log(`plan-loop gate passed via ${AUTO_OK_LABEL} label -> next=ISSUE_CREATE`);
    return 'approved';
  }

  ensurePlanGateLabels();
  const commentBody = postPlanApprovalRequest(issueNumber, approvedPlan);
  addIssueLabel(issueNumber, PENDING_APPROVAL_LABEL);
  appendPlanManifestEntry(issueNumber, buildManifestEntry({
    stage: 'GATE',
    sessionId: null,
    verdict: 'PENDING_APPROVAL',
    backendCostUsd: null,
    backendCostSource: null,
    backend: null,
    resultText: commentBody,
  }));
  log(`plan-loop pending approval — added ${PENDING_APPROVAL_LABEL}; add ${PLAN_APPROVED_LABEL} and run: node scripts/inner-loop.mjs --plan ${issueNumber} --resume`);
  return 'pending';
}

function resumePlanLoop(issueNumber) {
  const pending = resolvePendingPlanGate(readManifestStages(planManifestPathFor(issueNumber)));
  if (!pending.ok) die(`plan-loop resume unavailable: ${pending.reason}`);

  const issue = fetchIssue(issueNumber);
  if (!issueHasLabel(issue, PLAN_APPROVED_LABEL)) {
    log(`plan-loop approval pending — ${PLAN_APPROVED_LABEL} label not present on source issue #${issueNumber}`);
    return 2;
  }

  appendPlanGatePass(issueNumber, `${PLAN_APPROVED_LABEL} label present on source issue #${issueNumber}`);
  log(`plan-loop gate approved via ${PLAN_APPROVED_LABEL} label -> next=ISSUE_CREATE`);
  return completePlanLoopIssueCreate(issueNumber, pending.approvedPlan);
}

function runPlanLoop(issueNumber, backendFlags, options = {}) {
  if (options.resume) return resumePlanLoop(issueNumber);

  const issue = fetchIssue(issueNumber);
  const touchesGrounding = collectTouchesGroundingReport();
  let state = 'RESEARCH';
  let cycles = 0;
  let research = '';
  let approvedPlan = '';
  let feedback = null;

  while (state !== 'GATE' && state !== 'ISSUE_CREATE' && state !== 'ESCALATE') {
    const prompt = buildStagePrompt(state, {
      mode: 'plan-loop',
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      research,
      plan: approvedPlan,
      feedback,
      touchesGrounding: state === 'RESEARCH' ? touchesGrounding : undefined,
    });
    const backend = selectBackend(state, backendFlags);
    log(`plan-loop stage=${displayStage(state)} backend=${backend} cwd=${REPO_ROOT} — spawning ${backend}`);
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
      onRetry: () => log(`plan-loop stage=${displayStage(state)} verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });
    const { envelope, verdict } = stageResult;

    if (verdict === null) {
      writePlanEscalation(issueNumber, state, UNPARSABLE_VERDICT, envelope.result ?? '');
      state = 'ESCALATE';
      break;
    }

    if (state === 'RESEARCH' && verdict === 'PASS') research = envelope.result;
    if (state === 'PLAN' && verdict === 'PLAN_READY') approvedPlan = envelope.result;
    if (state === 'PLAN_REVIEW' && verdict === 'CHANGES') feedback = envelope.result;
    if (state === 'PLAN_REVIEW' && verdict === 'PASS') feedback = null;

    const { next, cycles: nextCycles } = nextPlanLoopState(state, verdict, cycles);
    if (next === 'ESCALATE') writePlanEscalation(issueNumber, state, verdict, envelope.result ?? '');
    log(`plan-loop stage=${displayStage(state)} verdict=${verdict} -> next=${displayStage(next)} (cycles=${nextCycles})`);
    state = next;
    cycles = nextCycles;
  }

  if (state === 'ESCALATE') die(`plan-loop escalated — see .lathe/runs/plan-${issueNumber}.escalation.md`);
  if (state === 'GATE') {
    const gateIssue = fetchIssue(issueNumber);
    const gate = handlePlanApprovalGate(issueNumber, gateIssue, approvedPlan);
    if (gate === 'pending') return 0;
    const next = nextPlanLoopState('GATE', 'PASS', cycles);
    state = next.next;
    cycles = next.cycles;
  }

  if (state === 'ISSUE_CREATE') return completePlanLoopIssueCreate(issueNumber, approvedPlan);
  return 0;
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const parsedArgs = parseDriverArgs(process.argv.slice(2));
  const { mode, dryRun, resume, backendFlags } = parsedArgs;
  // impl mode's run identity: a Backlog.md task unit ({ kind: 'task', id })
  // when --task/TASK-<n> was given, otherwise the legacy plain GitHub issue
  // number (ADR 0025 §4 / TASK-1.2). plan-loop always uses the plain issue
  // number (parsedArgs.unit is only ever populated for mode==='impl').
  const issueNumber = parsedArgs.unit ?? parsedArgs.issueNumber;

  if (parsedArgs.error) {
    die(`${parsedArgs.error}\nusage: node scripts/inner-loop.mjs <issue#|TASK-<n>|--task TASK-<n>> [--resume] [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]\n       node scripts/inner-loop.mjs --plan <issue#> [--resume] [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]`);
  }

  if (mode === 'plan') {
    if (dryRun) {
      dryRunPlanLoop(issueNumber, backendFlags);
      process.exit(0);
    }
    const exitCode = runPlanLoop(issueNumber, backendFlags, { resume });
    process.exit(exitCode ?? 0);
  }

  if (dryRun) {
    if (resume) {
      const resumeState = resolveResumeState(issueNumber);
      if (!resumeState.ok) dieResumeUnavailable(issueNumber, resumeState.reason);
      log(`dry-run: resume ${unitDisplayLabel(issueNumber)} from ${manifestPathFor(issueNumber)}`);
      log(`dry-run: skipped=${resumeState.skipped.length ? resumeState.skipped.join(',') : '(none)'} next=${resumeState.state} head=${resumeState.headSha ?? '(none)'} cycles=${resumeState.cycles}`);
      for (const stamp of resumeState.receiptsToStamp) {
        log(`dry-run: would stamp receipt stage=${stamp.stage} verdict=${stamp.verdict} head=${stamp.headSha}`);
      }
      if (resumeState.state === 'MERGE') {
        log(`dry-run: MERGE — node scripts/merge.mjs ${resumeState.branch} (from repo root)`);
        process.exit(0);
      }
      const backend = selectBackend(resumeState.state, backendFlags);
      const cwd = stageCwd(resumeState.state, REPO_ROOT, resumeState.worktreePath);
      const reviewHistory = resumeState.state === 'REVIEW'
        ? buildReviewHistorySummary(readManifestStages(manifestPathFor(issueNumber)))
        : '';
      const promptPreview = buildStagePrompt(resumeState.state, {
        issueNumber, issueTitle: '<title>', issueBody: '<body>',
        plan: resumeState.plan, feedback: resumeState.feedback,
        headSha: resumeState.headSha, verifyResult: resumeState.verifyResult,
        reviewHistory,
      });
      log(`dry-run: stage=${resumeState.state} backend=${backend} cwd=${cwd}`);
      log(`dry-run: prompt preview:\n${promptPreview}\n`);
      process.exit(0);
    }
    const fetchLabel = isTaskUnitLike(issueNumber)
      ? `backlog task view ${issueNumber.id} --plain`
      : 'gh issue view';
    log(`dry-run: fetching ${unitDisplayLabel(issueNumber)} via ${fetchLabel}`);
    const issue = fetchUnit(issueNumber);
    const runPlan = selectRunPlan({ mode: 'impl', issueBody: issue.body });
    if (runPlan.skipPlan) {
      log('dry-run: approved plan marker detected; skipping PLAN');
      log('dry-run: synthetic manifest entry stage=PLAN verdict=PLAN_READY skipped=true');
      log(`dry-run: next=${runPlan.initialState}`);
    }
    const { branch: wtBranch, dirName: wtDirName } = worktreeNameFor(issueNumber);
    const wtPath = join(REPO_ROOT, '.claude', 'worktrees', wtDirName);
    log(`dry-run: would create worktree ${wtPath} on branch ${wtBranch}`);
    log(`dry-run: would run pnpm ${WORKTREE_DEPS_INSTALL_ARGS.join(' ')} in ${wtPath}`);
    log('dry-run: pnpm install failure would warn and continue with P3 fallback');
    for (const stage of runPlan.stages) {
      if (stage === 'MERGE') {
        log(`dry-run: MERGE — node scripts/merge.mjs ${wtBranch} (from repo root)`);
        continue;
      }
      const cwd = stageCwd(stage, REPO_ROOT, wtPath);
      const promptPreview = buildStagePrompt(stage, {
        issueNumber, issueTitle: issue.title, issueBody: issue.body,
        plan: runPlan.approvedPlan || '<plan>', headSha: '<sha>', verifyResult: '<verify result>',
      });
      logDryRunStage(stage, backendFlags, cwd, promptPreview);
    }
    if (isTaskUnitLike(issueNumber)) {
      log(`dry-run: MERGE-pre — backlog task edit ${issueNumber.id} --status Done in worktree, committed, re-stamp review/verify receipts at new HEAD`);
    }
    log('dry-run: transition plan — PLAN_READY->IMPLEMENT, IMPL_DONE->REVIEW, REVIEW PASS->VERIFY / CHANGES->IMPLEMENT (max 2 cycles), VERIFY GREEN->MERGE / RED->TRIAGE, TRIAGE KNOWN->IMPLEMENT only when implementable / P4 Codex sandbox EPERM->ESCALATE / NOVEL->ESCALATE, missing/unparsable VERDICT->same stage retry once then ESCALATE');
    process.exit(0);
  }

  let worktreePath;
  let branch;
  let state;
  let cycles;
  let plan;
  let feedback;
  let headSha;
  let verifyResult;
  let issue = null;

  if (resume) {
    const resumeState = resolveResumeState(issueNumber);
    if (!resumeState.ok) dieResumeUnavailable(issueNumber, resumeState.reason);
    ({ worktreePath, branch, state, cycles, plan, feedback, headSha, verifyResult } = resumeState);
    log(`resume: skipped=${resumeState.skipped.length ? resumeState.skipped.join(',') : '(none)'} next=${state} head=${headSha ?? '(none)'} cycles=${cycles}`);
    for (const stamp of resumeState.receiptsToStamp) {
      stampReceiptOrDie(issueNumber, worktreePath, stamp);
    }
    if (state !== 'MERGE') issue = fetchUnit(issueNumber);
  } else {
    issue = fetchUnit(issueNumber);
    const runPlan = selectRunPlan({ mode: 'impl', issueBody: issue.body });
    const wt = prepareWorktree(issueNumber);
    worktreePath = wt.path;
    branch = wt.branch;
    state = runPlan.initialState;
    cycles = 0;
    plan = runPlan.approvedPlan;
    feedback = null;
    headSha = null;
    verifyResult = '';
    if (runPlan.skipPlan) {
      appendManifestEntry(issueNumber, buildSkippedPlanEntry(plan));
      log('approved plan marker detected; skipping PLAN');
    }
  }

  while (state !== 'MERGE' && state !== 'ESCALATE' && state !== 'DONE') {
    const cwd = stageCwd(state, REPO_ROOT, worktreePath);

    if (stageRequiresFreshMainRebase(state)) {
      log(`rebasing worktree onto main before ${state} (${unitDisplayLabel(issueNumber)})`);
      if (!rebaseWorktree(worktreePath)) {
        writeEscalation(issueNumber, state, 'REBASE_CONFLICT', `git rebase main failed in worktree before ${state}`);
        state = 'ESCALATE'; break;
      }
    }

    if (state === 'REVIEW' || state === 'VERIFY') {
      headSha = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    }

    const reviewHistory = state === 'REVIEW'
      ? buildReviewHistorySummary(readManifestStages(manifestPathFor(issueNumber)))
      : '';
    const prompt = buildStagePrompt(state, {
      issueNumber, issueTitle: issue.title, issueBody: issue.body,
      plan, feedback, headSha, verifyResult, reviewHistory,
    });

    const backend = selectBackend(state, backendFlags);
    log(`stage=${state} backend=${backend} cwd=${cwd} — spawning ${backend}`);
    const stageResult = runStageWithUnparsableRetry({
      runAttempt: () => {
        const stageStartedAt = Date.now();
        const envelope = runStage(state, prompt, cwd, null, backend);
        const durationMs = Math.max(1, Date.now() - stageStartedAt);
        const stageHeadSha = isWorktreeStage(state) ? worktreeHeadShaOrDie(worktreePath, state) : null;
        return { envelope, durationMs, stageHeadSha };
      },
      recordAttempt: ({ envelope, manifestVerdict, durationMs, stageHeadSha }) => {
        appendManifestEntry(issueNumber, buildManifestEntry({
          stage: state, sessionId: envelope.session_id ?? null,
          verdict: manifestVerdict,
          backendCostUsd: envelope.total_cost_usd ?? null,
          backendCostSource: backendCostSourceForEnvelope(envelope),
          backendModel: envelope.backend_model ?? null,
          backendTokenUsage: envelope.backend_token_usage ?? null,
          durationMs,
          backend: envelope.backend ?? null,
          headSha: stageHeadSha, resultText: envelope.result ?? '',
        }));
      },
      onRetry: () => log(`stage=${state} verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });
    const { envelope, verdict, stageHeadSha } = stageResult;

    if (verdict === null) { writeEscalation(issueNumber, state, UNPARSABLE_VERDICT, envelope.result ?? ''); state = 'ESCALATE'; break; }

    if (state === 'PLAN' && verdict === 'PLAN_READY') plan = envelope.result;
    if (state === 'REVIEW' && verdict === 'CHANGES') feedback = envelope.result;
    if (state === 'VERIFY' && verdict === 'RED') verifyResult = envelope.result;
    const nonImplementableKnown =
      state === 'TRIAGE' && verdict === 'KNOWN' && isCodexSandboxEpermTriageResult(envelope.result);
    if (state === 'TRIAGE' && verdict === 'KNOWN' && !nonImplementableKnown) feedback = envelope.result;

    const receipt = buildReceiptArgs(state, stageHeadSha ?? headSha, verdict);
    if (receipt) {
      const rr = spawnSync(receipt.command, receipt.args, { cwd: worktreePath, env: { ...process.env, ...receipt.env }, stdio: 'inherit' });
      if (rr.status !== 0) { writeEscalation(issueNumber, state, verdict, `receipt.mjs failed: ${receipt.args.join(' ')}`); state = 'ESCALATE'; break; }
    }

    const { next, cycles: nextCycles } = nextState(state, verdict, cycles, { nonImplementableKnown });
    if (next === 'ESCALATE') writeEscalation(issueNumber, state, verdict, envelope.result ?? '');
    const reason = nonImplementableKnown ? ' non-implementable-known=P4-codex-sandbox-eperm' : '';
    log(`stage=${state} verdict=${verdict} -> next=${next} (cycles=${nextCycles})${reason}`);
    state = next; cycles = nextCycles;
  }

  if (state === 'ESCALATE') die(`escalated — see ${escalationPathFor(issueNumber)}`);

  // Backstop: verify that main working tree has no unexpected tracked changes before
  // landing the branch.  The codex workspace-write sandbox should have confined writes
  // to the worktree, but we do NOT rely solely on sandbox enforcement (issue #39,
  // ADR 0014 §3).  Even if sandbox isolation held, a stray `git checkout` or an
  // unexpected tool call could dirty main.  Only tracked changes are checked;
  // untracked files (??) are ignored to avoid false positives from build artefacts.
  log(`backstop: checking main working tree for unexpected tracked changes before merge...`);
  const mainStatusR = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  const { dirty: mainDirty, paths: dirtyPaths } = detectMainDirty(mainStatusR.stdout ?? '');
  if (mainDirty) {
    const excerpt = `main working tree has ${dirtyPaths.length} unexpected tracked change(s) — sandbox write-isolation may have been breached:\n${dirtyPaths.join('\n')}`;
    writeEscalation(issueNumber, 'MERGE', 'MAIN_DIRTY_BACKSTOP', excerpt);
    die(`escalated — main has ${dirtyPaths.length} unexpected tracked change(s) before merge. See ${escalationPathFor(issueNumber)}`);
  }
  log(`backstop: main working tree clean — proceeding with merge.`);

  // Terminal status=Done (ADR 0025 §4 / TASK-1.2 AC#4): for a task unit, mark
  // the Backlog.md task Done in the worktree BEFORE merge, so the bookkeeping
  // commit rides along in the single squash-merged commit. merge.mjs itself
  // is unchanged — it still only squash-merges `branch` and checks receipts
  // against the (possibly updated) branch tip sha.
  if (isTaskUnitLike(issueNumber)) {
    log(`marking task ${issueNumber.id} Done in worktree before merge...`);
    const doneResult = markTaskDoneInWorktree(issueNumber.id, worktreePath, headSha);
    if (!doneResult.ok) {
      writeEscalation(issueNumber, 'MERGE', null, `backlog task edit --status Done failed\n\n${tailLines(doneResult.output)}`);
      die(`status=Done failed — see ${escalationPathFor(issueNumber)}`);
    }
    log(`status=Done: ${doneResult.output || '(no output)'}`);
  }

  log(`merging branch ${branch} onto main`);
  const mergeResult = runMerge(branch);
  if (!mergeResult.ok) {
    writeEscalation(issueNumber, 'MERGE', null, `node scripts/merge.mjs failed\n\n${tailLines(mergeResult.output)}`);
    die(`merge failed — see ${escalationPathFor(issueNumber)}`);
  }

  cleanupWorktree(worktreePath, branch);
  log(`done — ${unitDisplayLabel(issueNumber)} merged onto main.`);
  process.exit(0);
}
