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
  parseCodexSessionId, parseCodexCostUsd, parseBackendFlags, selectBackend,
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

// Bounded retries: review⇄implement (CHANGES) and triage⇄implement (KNOWN)
// share one cycle counter — "review⇄implement は 2 周まで" (ADR 0013 §1).
export const MAX_CYCLES = 2;

export const APPROVED_PLAN_HEADING = '## Plan (approved)';
export const IMPL_LOOP_STAGES = ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE'];
export const IMPL_LOOP_STAGES_AFTER_PLAN = ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE'];
export const PLAN_LOOP_STAGES = ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'ISSUE_CREATE', 'CLOSE_SOURCE'];
export const WORKTREE_DEPS_INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline'];

export function displayStage(stage) {
  return stage === 'PLAN_REVIEW' ? 'PLAN-REVIEW' : stage;
}

// --- Pure / testable exports ---

/**
 * Parse the VERDICT token from a stage's result text (last `VERDICT: <TOKEN>`
 * line wins). Returns null if absent/unparsable — callers must treat as ESCALATE.
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

/**
 * Parse driver flags while preserving backend flag handling in
 * inner-loop-backends.mjs.
 * @param {string[]} argv
 * @returns {{ mode: 'impl'|'plan', issueNumber: number|null, dryRun: boolean, resume: boolean, backendFlags: { global: string|null, stages: Record<string,string> }, error: string|null }}
 */
export function parseDriverArgs(argv) {
  let mode = 'impl';
  let issueArg = null;
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
    } else if (arg === '--backend' || /^--backend-[a-z-]+$/.test(arg)) {
      i += 1;
    } else if (arg.startsWith('--')) {
      return { mode, issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unknown argument: ${arg}` };
    } else if (issueArg == null) {
      issueArg = arg;
    } else {
      return { mode, issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unexpected positional argument: ${arg}` };
    }
  }

  const issueNumber = Number(issueArg);
  if (!issueArg || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { mode, issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: 'missing or invalid issue number' };
  }
  if (mode === 'plan' && resume) {
    return { mode, issueNumber, dryRun, resume, backendFlags: parseBackendFlags(argv), error: '--resume is only supported for impl-loop' };
  }
  return { mode, issueNumber, dryRun, resume, backendFlags: parseBackendFlags(argv), error: null };
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
      if (verdict === 'PASS') return { next: 'ISSUE_CREATE', cycles };
      if (verdict === 'CHANGES') {
        const next = cycles + 1;
        return next > MAX_CYCLES ? { next: 'ESCALATE', cycles: next } : { next: 'PLAN', cycles: next };
      }
      return { next: 'ESCALATE', cycles };
    default:
      return { next: 'ESCALATE', cycles };
  }
}

/**
 * Build one run-manifest entry (ADR 0013 §2 + ADR 0014 backend field).
 * @param {{ stage: string, sessionId: string|null, verdict: string|null, backendCostUsd?: number|null, backendCostSource?: string|null, costUsd?: number|null, durationMs?: number|null, ts?: string, backend?: string|null, headSha?: string|null, resultText?: string|null, skipped?: boolean }} p
 */
export function buildManifestEntry({
  stage,
  sessionId,
  verdict,
  backendCostUsd,
  backendCostSource,
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
  if (skipped === true) entry.skipped = true;
  return entry;
}

export function backendCostSourceForEnvelope(envelope) {
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

/**
 * Build escalation markdown with full REVIEW verdict history for outer recovery.
 * @param {{ issueNumber: number, stage: string, verdict: string|null, ts?: string, resultExcerpt?: string|null, reviewHistory?: Array<{ ordinal: number, verdict: string|null, headSha: string|null, ts: string|null, excerpt: string, hasContradictionMarker: boolean }> }} p
 * @returns {string}
 */
export function buildEscalationMarkdown({ issueNumber, stage, verdict, ts, resultExcerpt, reviewHistory = [] }) {
  const lines = [
    `# escalation — issue #${issueNumber}`,
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

// Build the full manifest object for writing.
export function buildManifest(issueNumber, stages, extra = {}) {
  return { issue: issueNumber, ...extra, stages };
}

function requiresResultText(stage, verdict) {
  return (
    (stage === 'PLAN' && verdict === 'PLAN_READY') ||
    (stage === 'REVIEW' && verdict === 'CHANGES') ||
    (stage === 'VERIFY' && verdict === 'RED') ||
    (stage === 'TRIAGE' && verdict === 'KNOWN') ||
    verdict === 'ESCALATE' ||
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
  parseCodexSessionId, parseCodexCostUsd, parseBackendFlags, selectBackend,
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
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,body'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) die(`gh issue view failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout); } catch (e) { die(`could not parse gh issue view output: ${e.message}`); }
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

export function buildImplementationIssueBody({ sourceIssueNumber, approvedPlan, dependsOn, touches }) {
  return [
    `Generated from #${sourceIssueNumber}`,
    `Depends-on: ${dependsOn ?? ''}`,
    `Touches: ${touches ?? ''}`,
    '',
    APPROVED_PLAN_HEADING,
    stripVerdictLine(approvedPlan),
    '',
  ].join('\n');
}

export function parseGhIssueNumber(output) {
  const text = String(output ?? '');
  const urlMatch = text.match(/\/issues\/(\d+)\b/);
  if (urlMatch) return Number(urlMatch[1]);
  const hashMatch = text.match(/#(\d+)\b/);
  return hashMatch ? Number(hashMatch[1]) : null;
}

function createImplementationIssue(sourceIssueNumber, approvedPlan) {
  const parsed = parseApprovedPlanForIssue(approvedPlan);
  if (!parsed.title) {
    return { ok: false, error: 'approved plan is missing required "Title:" line' };
  }
  if (parsed.touches == null) {
    return { ok: false, error: 'approved plan is missing required "Touches:" line' };
  }
  const dependsOnResult = parseDependsOnLine(parsed.dependsOn);
  if (!dependsOnResult.ok) {
    return { ok: false, error: dependsOnResult.error };
  }
  const body = buildImplementationIssueBody({
    sourceIssueNumber,
    approvedPlan,
    dependsOn: dependsOnResult.dependsOn,
    touches: parsed.touches,
  });
  const r = spawnSync('gh', ['issue', 'create', '--title', parsed.title, '--body-file', '-', '--label', 'inner-loop'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    return { ok: false, error: `gh issue create failed: ${r.stderr || r.stdout}` };
  }
  const issueNumber = parseGhIssueNumber(r.stdout);
  if (!issueNumber) {
    return { ok: false, error: `could not parse created issue number from gh output: ${r.stdout}` };
  }
  return { ok: true, issueNumber, url: r.stdout.trim(), body, title: parsed.title };
}

function closeSourceIssue(sourceIssueNumber, createdIssue) {
  const comment = [
    `plan-loop created implementation issue #${createdIssue.issueNumber}.`,
    '',
    createdIssue.url,
  ].join('\n');
  const r = spawnSync('gh', ['issue', 'close', String(sourceIssueNumber), '--reason', 'completed', '--comment', comment], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function prepareWorktree(issueNumber, deps = {}) {
  const branch = `inner/issue-${issueNumber}`;
  const path = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issueNumber}`);
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
  return {
    branch: `inner/issue-${issueNumber}`,
    path: join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issueNumber}`),
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
  die(
    `resume unavailable: ${reason}. ` +
    `Start from scratch by running without --resume: node scripts/inner-loop.mjs ${issueNumber}. ` +
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

// Normalized envelope: { session_id, result, total_cost_usd, backend }
function runStageClaude(stage, prompt, cwd, resumeSessionId) {
  const args = buildClaudeArgs(stage, prompt, resumeSessionId);
  const r = spawnSync('claude', args, { encoding: 'utf8', cwd, maxBuffer: 1e8 });
  if (r.status !== 0 && !r.stdout) die(`claude -p failed for stage ${stage}: ${r.stderr || 'no output'}`);
  let env;
  try { env = JSON.parse(r.stdout); } catch (e) {
    die(`could not parse claude envelope for stage ${stage}: ${e.message}\nstdout: ${r.stdout}`);
  }
  return { session_id: env.session_id ?? null, result: env.result ?? '', total_cost_usd: env.total_cost_usd ?? null, backend: 'claude' };
}

function runStageCodex(stage, prompt, cwd) {
  const { agent } = stagePermissions(stage);
  const agentFile = join(REPO_ROOT, '.claude', 'agents', `${agent}.md`);
  const agentBody = existsSync(agentFile) ? stripFrontmatter(readFileSync(agentFile, 'utf8')) : '';
  const fullPrompt = buildCodexPrompt(agentBody, prompt);
  const lastmsgPath = join(tmpdir(), `lathe-inner-stage-${stage}.txt`);
  const args = buildCodexArgs(stage, fullPrompt, cwd, lastmsgPath, REPO_ROOT);
  const r = spawnSync('codex', ['exec', ...args], { encoding: 'utf8', cwd, maxBuffer: 1e8 });
  if (r.status !== 0 && !r.stdout) die(`codex exec failed for stage ${stage}: ${r.stderr || 'no output'}`);
  const sessionId = parseCodexSessionId(r.stdout ?? '');
  const costUsd = parseCodexCostUsd(r.stdout ?? '');
  const result = existsSync(lastmsgPath) ? readFileSync(lastmsgPath, 'utf8') : '';
  return { session_id: sessionId, result, total_cost_usd: costUsd, backend: 'codex' };
}

/**
 * Run one stage via the specified backend, returning a normalized envelope.
 * @param {string} stage
 * @param {string} prompt
 * @param {string} cwd
 * @param {string | null} resumeSessionId  (claude backend only)
 * @param {string} backend  'claude' | 'codex' (default 'codex')
 * @returns {{ session_id: string|null, result: string, total_cost_usd: number|null, backend: string }}
 */
function runStage(stage, prompt, cwd, resumeSessionId = null, backend = 'codex') {
  return backend === 'codex'
    ? runStageCodex(stage, prompt, cwd)
    : runStageClaude(stage, prompt, cwd, resumeSessionId);
}

function manifestPathFor(issueNumber) {
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

function writeEscalation(issueNumber, stage, verdict, resultExcerpt) {
  const p = join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.escalation.md`);
  mkdirSync(dirname(p), { recursive: true });
  const reviewHistory = collectReviewHistory(readManifestStages(manifestPathFor(issueNumber)));
  appendFileSync(p, buildEscalationMarkdown({
    issueNumber,
    stage,
    verdict,
    resultExcerpt,
    reviewHistory,
  }), 'utf8');
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
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW']) {
    const promptPreview = buildStagePrompt(stage, {
      mode: 'plan-loop',
      issueNumber,
      issueTitle: '<title>',
      issueBody: '<body>',
      research: '<research>',
      plan: '<approved plan candidate>',
      feedback: '<plan-review feedback>',
    });
    logDryRunStage(stage, backendFlags, REPO_ROOT, promptPreview);
  }
  log('dry-run: ISSUE_CREATE — gh issue create --label inner-loop --body-file -');
  log(`dry-run: ISSUE_CREATE body includes Generated from #${issueNumber}, Depends-on:, Touches:, ${APPROVED_PLAN_HEADING}`);
  log(`dry-run: CLOSE_SOURCE — gh issue close ${issueNumber} --reason completed --comment '<created issue>'`);
  log('dry-run: transition plan — RESEARCH PASS->PLAN, PLAN_READY->PLAN-REVIEW, PLAN-REVIEW PASS->ISSUE_CREATE / CHANGES->PLAN (max 2 cycles), gh issue create -> CLOSE_SOURCE, missing/unparsable VERDICT->ESCALATE');
}

function runPlanLoop(issueNumber, backendFlags) {
  const issue = fetchIssue(issueNumber);
  let state = 'RESEARCH';
  let cycles = 0;
  let research = '';
  let approvedPlan = '';
  let feedback = null;

  while (state !== 'ISSUE_CREATE' && state !== 'ESCALATE') {
    const prompt = buildStagePrompt(state, {
      mode: 'plan-loop',
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      research,
      plan: approvedPlan,
      feedback,
    });
    const backend = selectBackend(state, backendFlags);
    log(`plan-loop stage=${displayStage(state)} backend=${backend} cwd=${REPO_ROOT} — spawning ${backend}`);
    const stageStartedAt = Date.now();
    const envelope = runStage(state, prompt, REPO_ROOT, null, backend);
    const durationMs = Math.max(1, Date.now() - stageStartedAt);
    const verdict = parseVerdict(envelope.result);

    appendPlanManifestEntry(issueNumber, buildManifestEntry({
      stage: state,
      sessionId: envelope.session_id ?? null,
      verdict,
      backendCostUsd: envelope.total_cost_usd ?? null,
      backendCostSource: backendCostSourceForEnvelope(envelope),
      durationMs,
      backend: envelope.backend ?? null,
      resultText: envelope.result ?? '',
    }));

    if (verdict === null) {
      writePlanEscalation(issueNumber, state, null, envelope.result ?? '');
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

  const created = createImplementationIssue(issueNumber, approvedPlan);
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
    resultText: `created #${created.issueNumber}\n${created.url}`,
  }));
  log(`plan-loop created implementation issue #${created.issueNumber}: ${created.url}`);

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
  log(`plan-loop done — created implementation issue #${created.issueNumber} and closed source issue #${issueNumber}.`);
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const parsedArgs = parseDriverArgs(process.argv.slice(2));
  const { mode, issueNumber, dryRun, resume, backendFlags } = parsedArgs;

  if (parsedArgs.error) {
    die(`${parsedArgs.error}\nusage: node scripts/inner-loop.mjs <issue#> [--resume] [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]\n       node scripts/inner-loop.mjs --plan <issue#> [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]`);
  }

  if (mode === 'plan') {
    if (dryRun) {
      dryRunPlanLoop(issueNumber, backendFlags);
      process.exit(0);
    }
    runPlanLoop(issueNumber, backendFlags);
    process.exit(0);
  }

  if (dryRun) {
    if (resume) {
      const resumeState = resolveResumeState(issueNumber);
      if (!resumeState.ok) dieResumeUnavailable(issueNumber, resumeState.reason);
      log(`dry-run: resume issue #${issueNumber} from ${manifestPathFor(issueNumber)}`);
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
    log(`dry-run: fetching issue #${issueNumber} via gh issue view`);
    const issue = fetchIssue(issueNumber);
    const runPlan = selectRunPlan({ mode: 'impl', issueBody: issue.body });
    if (runPlan.skipPlan) {
      log('dry-run: approved plan marker detected; skipping PLAN');
      log('dry-run: synthetic manifest entry stage=PLAN verdict=PLAN_READY skipped=true');
      log(`dry-run: next=${runPlan.initialState}`);
    }
    const wtPath = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issueNumber}`);
    log(`dry-run: would create worktree ${wtPath} on branch inner/issue-${issueNumber}`);
    log(`dry-run: would run pnpm ${WORKTREE_DEPS_INSTALL_ARGS.join(' ')} in ${wtPath}`);
    log('dry-run: pnpm install failure would warn and continue with P3 fallback');
    for (const stage of runPlan.stages) {
      if (stage === 'MERGE') {
        log('dry-run: MERGE — node scripts/merge.mjs inner/issue-<n> (from repo root)');
        continue;
      }
      const cwd = stageCwd(stage, REPO_ROOT, wtPath);
      const promptPreview = buildStagePrompt(stage, {
        issueNumber, issueTitle: issue.title, issueBody: issue.body,
        plan: runPlan.approvedPlan || '<plan>', headSha: '<sha>', verifyResult: '<verify result>',
      });
      logDryRunStage(stage, backendFlags, cwd, promptPreview);
    }
    log('dry-run: transition plan — PLAN_READY->IMPLEMENT, IMPL_DONE->REVIEW, REVIEW PASS->VERIFY / CHANGES->IMPLEMENT (max 2 cycles), VERIFY GREEN->MERGE / RED->TRIAGE, TRIAGE KNOWN->IMPLEMENT only when implementable / P4 Codex sandbox EPERM->ESCALATE / NOVEL->ESCALATE, missing/unparsable VERDICT->ESCALATE');
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
    if (state !== 'MERGE') issue = fetchIssue(issueNumber);
  } else {
    issue = fetchIssue(issueNumber);
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
      log(`rebasing worktree onto main before ${state} (issue #${issueNumber})`);
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
    const stageStartedAt = Date.now();
    const envelope = runStage(state, prompt, cwd, null, backend);
    const durationMs = Math.max(1, Date.now() - stageStartedAt);
    const verdict = parseVerdict(envelope.result);
    const stageHeadSha = isWorktreeStage(state) ? worktreeHeadShaOrDie(worktreePath, state) : null;

    appendManifestEntry(issueNumber, buildManifestEntry({
      stage: state, sessionId: envelope.session_id ?? null,
      verdict,
      backendCostUsd: envelope.total_cost_usd ?? null,
      backendCostSource: backendCostSourceForEnvelope(envelope),
      durationMs,
      backend: envelope.backend ?? null,
      headSha: stageHeadSha, resultText: envelope.result ?? '',
    }));

    if (verdict === null) { writeEscalation(issueNumber, state, null, envelope.result ?? ''); state = 'ESCALATE'; break; }

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

  if (state === 'ESCALATE') die(`escalated — see .lathe/runs/issue-${issueNumber}.escalation.md`);

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
    die(`escalated — main has ${dirtyPaths.length} unexpected tracked change(s) before merge. See .lathe/runs/issue-${issueNumber}.escalation.md`);
  }
  log(`backstop: main working tree clean — proceeding with merge.`);

  log(`merging branch ${branch} onto main`);
  const mergeResult = runMerge(branch);
  if (!mergeResult.ok) {
    writeEscalation(issueNumber, 'MERGE', null, `node scripts/merge.mjs failed\n\n${tailLines(mergeResult.output)}`);
    die(`merge failed — see .lathe/runs/issue-${issueNumber}.escalation.md`);
  }

  cleanupWorktree(worktreePath, branch);
  log(`done — issue #${issueNumber} merged onto main.`);
  process.exit(0);
}
