// inner-loop-core.mjs — shared pure logic for the inner-loop driver
// (scripts/inner-loop.mjs) and the plan-task runner
// (scripts/inner-loop-plan-task.mjs). Split from inner-loop.mjs at the #116
// task-loop shrink to keep every module under the 500-line file-size guard.
//
// After the shrink (ADR 0030 §2-3) the driver has two run types:
//   - task loop: IMPLEMENT (worktree) → LAND (PR creation, Closes #N,
//     auto-merge armed at PR-creation time — 監査役裁定 1/4, 2026-07-07)
//   - plan-task: PLAN (repo root) → FILE_CHILDREN | ASK_PDM
// The stage tables are ordered arrays so an inspection stage can be inserted
// later without reshaping the driver (監査役裁定 2).
//
// Everything here is pure or fs-read-only; no spawnSync.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

// --- Constants ---

export const VALID_VERDICT_TOKENS = ['PLAN_READY', 'ASK_PDM', 'IMPL_DONE', 'ESCALATE', 'PASS', 'RED'];
export const UNPARSABLE_VERDICT = 'UNPARSABLE';
export const MAX_UNPARSABLE_STAGE_RETRIES = 1;

export const NEEDS_PLAN_LABEL = 'needs-plan';
export const NEEDS_REVIEW_LABEL = 'needs-review';
export const TASK_REQUEST_LABEL = 'task-request';

// Maximum PLAN_REVIEW RED-verdict retries before labelling needs-review +
// escalation and stopping (ADR 0035 §5).
export const MAX_PLAN_REVIEW_RETRIES = 2;

// Stage tables — ordered so a later stage insertion is a one-line change
// (append to the array + add its ok-verdict). The terminal after the last
// stage is a driver action, not an agent stage.
//
// ADR 0035 §1: all tasks now go through TASK_PLAN → PLAN_REVIEW → IMPLEMENT.
// TASK_PLAN is distinct from plan-task PLAN (plan-task creates child issues;
// TASK_PLAN posts a plan comment on the current issue).
export const TASK_LOOP_STAGES = ['TASK_PLAN', 'PLAN_REVIEW', 'IMPLEMENT'];
export const TASK_LOOP_TERMINAL = 'LAND';
const TASK_LOOP_OK_VERDICTS = { TASK_PLAN: 'PLAN_READY', PLAN_REVIEW: 'PASS', IMPLEMENT: 'IMPL_DONE' };

export const PLAN_TASK_STAGES = ['PLAN'];
export const PLAN_TASK_TERMINAL = 'FILE_CHILDREN';
const PLAN_TASK_OK_VERDICTS = { PLAN: 'PLAN_READY' };

export const WORKTREE_DEPS_INSTALL_ARGS = ['install', '--frozen-lockfile', '--prefer-offline'];

// design/plan-format.md is injected into every plan-task PLAN prompt,
// fail-closed (#142 absorbed into #116): if the file is missing or unreadable
// the run refuses to start — no silent fallback to an uninjected prompt.
export const PLAN_FORMAT_PATH = 'design/plan-format.md';

// --- Verdict parsing ---

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

// --- Run-type selection and transitions ---

/**
 * Select the run type for an issue from its label names (ADR 0030 追記 A:
 * needs-plan label → plan-task, otherwise implementation task. The machine
 * reads only this mechanical fact — no body structure checks).
 * @param {string[]} labelNames
 * @returns {'plan-task' | 'task'}
 */
export function selectRunType(labelNames) {
  const names = Array.isArray(labelNames) ? labelNames : [];
  return names.some((name) => String(name).toLowerCase() === NEEDS_PLAN_LABEL) ? 'plan-task' : 'task';
}

/**
 * Task-loop transition (ADR 0030 §3: local stages are IMPLEMENT → PR creation
 * only). Table-driven over TASK_LOOP_STAGES so a stage can be inserted later.
 * Terminal states: LAND (driver lands the branch via PR), ESCALATE.
 * @param {string} state
 * @param {string | null} verdict
 * @returns {{ next: string }}
 */
export function nextState(state, verdict) {
  if (verdict === null) return { next: 'ESCALATE' };
  const idx = TASK_LOOP_STAGES.indexOf(state);
  if (idx < 0) return { next: 'ESCALATE' };
  if (verdict !== TASK_LOOP_OK_VERDICTS[state]) return { next: 'ESCALATE' };
  return { next: TASK_LOOP_STAGES[idx + 1] ?? TASK_LOOP_TERMINAL };
}

/**
 * plan-task transition (ADR 0030 §2). Terminal states: FILE_CHILDREN (plan
 * confirmed → children filed → source closed), ASK_PDM (正常終端 — PdM 判断が
 * 必要な選択肢に到達, ADR 0030 追記 E), ESCALATE. Table-driven over
 * PLAN_TASK_STAGES so an inspection stage can be inserted later
 * (#116 監査役裁定 2; plan review 欠落の裁定は #170).
 * @param {string} state
 * @param {string | null} verdict
 * @returns {{ next: string }}
 */
export function nextPlanTaskState(state, verdict) {
  if (verdict === null) return { next: 'ESCALATE' };
  if (verdict === 'ASK_PDM') return { next: 'ASK_PDM' };
  const idx = PLAN_TASK_STAGES.indexOf(state);
  if (idx < 0) return { next: 'ESCALATE' };
  if (verdict !== PLAN_TASK_OK_VERDICTS[state]) return { next: 'ESCALATE' };
  return { next: PLAN_TASK_STAGES[idx + 1] ?? PLAN_TASK_TERMINAL };
}

// --- CLI args ---

/**
 * Parse driver flags. The unit of execution is a GitHub issue number
 * (issue = task, ADR 0031 — the old `--task TASK-<n>` / Backlog.md unit and
 * the `--plan` mode flag are gone; the run type comes from the issue labels).
 * Backend flags are parsed in inner-loop-backends.mjs.
 * @param {string[]} argv
 * @param {(argv: string[]) => object} parseBackendFlags
 * @returns {{ issueNumber: number|null, dryRun: boolean, resume: boolean, backendFlags: object, error: string|null }}
 */
export function parseDriverArgsWith(argv, parseBackendFlags) {
  let issueArg = null;
  let dryRun = false;
  let resume = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--resume') {
      resume = true;
    } else if (arg === '--backend' || /^--backend-[a-z-]+$/.test(arg)) {
      i += 1;
    } else if (arg.startsWith('--')) {
      return { issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unknown argument: ${arg}` };
    } else if (issueArg == null) {
      issueArg = arg;
    } else {
      return { issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: `unexpected positional argument: ${arg}` };
    }
  }

  const issueNumber = Number(issueArg);
  if (!issueArg || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { issueNumber: null, dryRun, resume, backendFlags: parseBackendFlags(argv), error: 'missing or invalid issue number' };
  }
  return { issueNumber, dryRun, resume, backendFlags: parseBackendFlags(argv), error: null };
}

// --- blocked-by (ADR 0031 §2) ---

/**
 * Extract `blocked-by #N` references from an issue body (ADR 0031 §2: 依存
 * 関係は body の blocked-by 記法を driver/engine が読む). Accepts an optional
 * colon and multiple refs per mention ("blocked-by #12, #13"). Deduplicated
 * in first-seen order.
 * @param {string | null | undefined} body
 * @returns {number[]}
 */
export function parseBlockedBy(body) {
  const seen = new Set();
  const refs = [];
  for (const mention of String(body ?? '').matchAll(/blocked-by\s*:?\s*((?:#\d+[ \t,]*)+)/gi)) {
    for (const ref of mention[1].matchAll(/#(\d+)/g)) {
      const n = Number(ref[1]);
      if (!seen.has(n)) {
        seen.add(n);
        refs.push(n);
      }
    }
  }
  return refs;
}

// --- Issue helpers ---

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

/**
 * Returns true when the issue carries the `needs-review` label (ADR 0035 §1).
 * @param {object} issue
 * @returns {boolean}
 */
export function hasNeedsReviewLabel(issue) {
  return issueHasLabel(issue, NEEDS_REVIEW_LABEL);
}

// --- Manifest ---

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

// Build the full manifest object for writing.
export function buildManifest(issueNumber, stages, extra = {}) {
  return { issue: issueNumber, ...extra, stages };
}

// Read existing manifest (if present), returning stages array or [].
export function readManifestStages(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.stages) ? data.stages : [];
  } catch { return []; }
}

// --- Escalation markdown (provisional surface, #116 監査役裁定 3;
// escalation-issue 投函への置換は #117 scope) ---

function clippedExcerpt(text, maxChars = 4000) {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) return value;
  return `...${value.slice(-maxChars)}`;
}

/**
 * @param {{ issueNumber: number, stage: string, verdict: string|null, ts?: string, resultExcerpt?: string|null }} p
 * @returns {string}
 */
export function buildEscalationMarkdown({ issueNumber, stage, verdict, ts, resultExcerpt }) {
  return [
    `# escalation — issue #${issueNumber}`,
    '',
    `stage: ${stage}`,
    `verdict: ${verdict ?? '(none/unparsable)'}`,
    `ts: ${ts ?? new Date().toISOString()}`,
    '',
    '## result excerpt',
    '',
    '```',
    clippedExcerpt(resultExcerpt, 4000),
    '```',
    '',
  ].join('\n');
}

// --- Resume ---

function requiresResultText(stage, verdict) {
  return (
    verdict === 'ESCALATE' ||
    verdict === UNPARSABLE_VERDICT ||
    verdict === null
  );
}

// Only IMPLEMENT runs inside the task worktree. TASK_PLAN and PLAN_REVIEW run
// at repo root (ADR 0035 §1 — plan stages are read-only at repo root).
export function isWorktreeStage(stage) {
  return stage === 'IMPLEMENT';
}

export function stageRequiresFreshMainRebase(stage) {
  return stage === 'IMPLEMENT';
}

/**
 * Decide where a manifest-backed task-loop run can resume. The walkable
 * stages are the task-loop stages (all worktree stages); a completed walk
 * resumes at LAND (the driver's landing action).
 * @param {{ stages: object[], worktree: { exists: boolean, branchMatches: boolean, clean: boolean, headSha: string|null } }} p
 * @returns {{ ok: true, state: string, headSha: string|null, skipped: string[] } | { ok: false, reason: string }}
 */
export function decideResumeState({ stages, worktree }) {
  if (!Array.isArray(stages) || stages.length === 0) return { ok: false, reason: 'missing manifest or manifest has no stages' };
  if (!worktree?.exists) return { ok: false, reason: 'missing worktree' };
  if (!worktree.branchMatches) return { ok: false, reason: 'worktree branch mismatch' };
  if (!worktree.clean) return { ok: false, reason: 'dirty worktree' };
  if (!worktree.headSha) return { ok: false, reason: 'could not determine worktree HEAD sha' };

  // Only worktree stages appear in the manifest (TASK_PLAN/PLAN_REVIEW run in
  // the repo root and do not write manifest entries). Walk only those stages.
  const walkable = TASK_LOOP_STAGES.filter(isWorktreeStage);
  let state = walkable[0];
  let expectedHeadSha = null;
  const skipped = [];
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
      return { ok: true, state: entry.stage, headSha: worktree.headSha, skipped };
    }

    if (isUnparsableManifestVerdict(verdict)) {
      unparsableAttemptsForState += 1;
      if (unparsableAttemptsForState > MAX_UNPARSABLE_STAGE_RETRIES) {
        return { ok: false, reason: `unparsable retry exhausted for ${entry.stage}` };
      }
      continue;
    }
    unparsableAttemptsForState = 0;

    const next = nextState(entry.stage, verdict);
    if (next.next === 'ESCALATE') {
      const mismatch = shaMismatch();
      if (mismatch) return mismatch;
      return { ok: true, state: entry.stage, headSha: worktree.headSha, skipped };
    }
    skipped.push(entry.stage);
    state = next.next;
  }

  if (expectedHeadSha && worktree.headSha !== expectedHeadSha) {
    return { ok: false, reason: `sha mismatch: manifest head_sha=${expectedHeadSha} worktree HEAD=${worktree.headSha}` };
  }

  return { ok: true, state, headSha: worktree.headSha, skipped };
}

// --- Worktree naming ---

export function worktreeNameFor(issueNumber) {
  return { branch: `inner/issue-${issueNumber}`, dirName: `inner-issue-${issueNumber}` };
}

// --- Landing pure functions (ADR 0030 §3; landBranch itself lives in
// inner-loop.mjs because it spawns) ---

/** First commit message from `git log --reverse --format=%B%x00` (NUL-separated records).
 * @param {string} logOutput @returns {string} */
export function extractFirstCommitMessage(logOutput) {
  return logOutput.split('\0')[0].trim();
}

/** subject = first line; body = rest (falls back to subject when subject-only).
 * @param {string} msg @returns {{subject:string,body:string}} */
export function splitCommitMessage(msg) {
  const lines = (msg ?? '').split('\n');
  const subject = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').trim();
  return { subject, body: body || subject };
}

/** Append `Closes #<n>` unless the body already carries it (case-insensitive)
 * (#116 監査役裁定 4: merge = issue close = Done, ADR 0031 derived status).
 * @param {string} body @param {number} issueNumber @returns {string} */
export function buildPrBodyWithCloses(body, issueNumber) {
  const base = String(body ?? '').trim();
  if (new RegExp(`\\bCloses #${issueNumber}\\b`, 'i').test(base)) return base;
  const marker = `Closes #${issueNumber}`;
  return base ? `${base}\n\n${marker}` : marker;
}

/** @param {{base:string,head:string,title:string,body:string}} p @returns {string[]} */
export function buildPrCreateArgs({ base, head, title, body }) {
  return ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body];
}

/** @param {{branch:string}} p @returns {string[]} argv for gh pr merge --auto --squash */
export function buildPrMergeArgs({ branch }) {
  return ['pr', 'merge', branch, '--auto', '--squash'];
}
