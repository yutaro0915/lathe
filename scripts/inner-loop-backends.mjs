// inner-loop-backends.mjs — stage permission tables + backend adapter pure functions
// (ADR 0013 §機構詳細 + ADR 0014). Separated from inner-loop.mjs to keep that file
// under the 500-line guard. All exports are pure functions; no spawnSync here.

import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __backends_dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the inner-loop Claude settings file.
 * Passed as --settings to every `claude` spawn so the spawn cwd cannot
 * influence which settings layer is loaded (belt & braces against
 * settings.local implicit merge — ADR #206 分解 C).
 * Contract: INNER_SETTINGS_PATH = <REPO_ROOT>/.claude/settings.json (PR #223).
 */
export const INNER_SETTINGS_PATH = join(__backends_dirname, '..', '.claude', 'settings.json');

// plan-task PLAN reads source GitHub issues (issue = task, ADR 0031) —
// read-only gh access only; child issue creation is the driver's job.
const READ_ONLY_GH_ISSUE_TOOLS = [
  'Bash(gh issue view *)',
  'Bash(gh issue list *)',
];

/**
 * Permission flags per stage (ADR 0013 §機構詳細).
 * Stages after ADR 0035: PLAN (plan-task), TASK_PLAN (task loop plan),
 * PLAN_REVIEW (machine review), and IMPLEMENT (task loop). Review runs on the
 * PR via the review engine; verify(tier=test) runs in CI.
 * --bare / --dangerously-skip-permissions must never be used (hooks must fire).
 * @param {string} stage
 * @returns {{ agent: string, permissionMode: string, allowedTools?: string[] }}
 */
export function stagePermissions(stage) {
  switch (stage) {
    case 'PLAN':
      return {
        agent: 'planner',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', ...READ_ONLY_GH_ISSUE_TOOLS],
      };
    case 'TASK_PLAN':
      // Task-loop plan stage: planner reads the issue and produces a plan
      // (plan-format.md compliant). Read-only at repo root (ADR 0035 §1).
      return {
        agent: 'planner',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', ...READ_ONLY_GH_ISSUE_TOOLS],
      };
    case 'PLAN_REVIEW':
      // Machine plan review: independent reviewer checks the plan (ADR 0035 §1).
      // Read-only at repo root.
      return {
        agent: 'reviewer',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob'],
      };
    case 'IMPLEMENT':
      // IMPLEMENT needs env-prefixed and compound verification/commit commands
      // (#44/#45). Containment is worktree cwd, the implementer role contract,
      // the main-dirty backstop, and the PR+CI landing gate.
      return {
        agent: 'implementer',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      };
    default:
      throw new Error(`stagePermissions: unknown stage "${stage}"`);
  }
}

// Stages that run at repo root (not in the task worktree).
const REPO_ROOT_STAGES = new Set(['PLAN', 'TASK_PLAN', 'PLAN_REVIEW']);

/**
 * cwd for a stage: plan-task PLAN, TASK_PLAN, and PLAN_REVIEW run at repo
 * root; IMPLEMENT runs in the task worktree. (ADR 0035 §1)
 * @param {string} stage
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {string}
 */
export function stageCwd(stage, repoRoot, worktreePath) {
  return REPO_ROOT_STAGES.has(stage) ? repoRoot : worktreePath;
}

// --- Backend adapter pure functions (ADR 0014) ---

const PRICING = JSON.parse(readFileSync(new URL('../apps/web/db/pricing.json', import.meta.url), 'utf8'));
const CLAUDE_RATES = PRICING.claude ?? {};
const CLAUDE_RATE_KEYS = Object.keys(CLAUDE_RATES).sort((a, b) => b.length - a.length);
const OPENAI_RATES = PRICING.openai ?? {};
const OPENAI_RATE_KEYS = Object.keys(OPENAI_RATES).sort((a, b) => b.length - a.length);
const TIER_RATES = PRICING.tiers ?? {};

const CODEX_EXPLICIT_COST_SOURCE = 'codex.jsonl.explicit_cost';
const CODEX_TURN_USAGE_SOURCE = 'codex.jsonl.turn.completed.usage';
const CODEX_TOKEN_COUNT_USAGE_SOURCE = 'codex.jsonl.token_count.total_token_usage';

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function tokenNumber(v) {
  return Math.max(0, finiteNumber(v) ?? 0);
}

function resolvePricingRate(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  for (const k of CLAUDE_RATE_KEYS) if (m.startsWith(k)) return CLAUDE_RATES[k];
  if (m.includes('opus')) return TIER_RATES.opus ?? null;
  if (m.includes('sonnet')) return TIER_RATES.sonnet ?? null;
  if (m.includes('haiku')) return TIER_RATES.haiku ?? null;
  for (const k of OPENAI_RATE_KEYS) if (m.startsWith(k)) return OPENAI_RATES[k];
  return null;
}

function normalizeCodexTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const hasCostFields = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
  ].some((v) => finiteNumber(v) !== null);
  if (!hasCostFields) return null;
  return {
    input_tokens: tokenNumber(usage.input_tokens),
    cached_input_tokens: tokenNumber(usage.cached_input_tokens),
    output_tokens: tokenNumber(usage.output_tokens),
    reasoning_output_tokens: tokenNumber(usage.reasoning_output_tokens),
  };
}

function addCodexTokenUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
  };
}

function codexCostForUsage(model, usage) {
  const rate = resolvePricingRate(model);
  if (!rate || !usage) return null;
  const input = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  return (
    (input * rate.input +
      usage.output_tokens * rate.output +
      usage.cached_input_tokens * rate.cacheRead) /
    1_000_000
  );
}

/**
 * Sandbox mode for a stage's codex exec invocation.
 * IMPLEMENT -> workspace-write; PLAN (plan-task, read-only) -> read-only.
 * @param {string} stage
 * @returns {'workspace-write' | 'read-only'}
 */
export function stageSandbox(stage) {
  return stage === 'IMPLEMENT' ? 'workspace-write' : 'read-only';
}

/**
 * Build argv for `codex exec <prompt> ...` (everything after 'exec').
 * NEVER includes --dangerously-bypass-* or --ephemeral.
 *
 * When the sandbox is workspace-write, also grants --add-dir <repoRoot>/.git.
 * A worktree's real git metadata (objects/refs/worktrees/logs) lives under the
 * main checkout's .git, outside the worktree's own workspace-write root, so
 * `git commit` inside the worktree needs write access there too. Granting the
 * whole .git directory (rather than enumerating subpaths) is deliberate: git's
 * internal layout there is not a stable fine-grained surface to allowlist, and
 * protecting main is already the job of the PR+CI landing gate (ADR 0026/0030)
 * plus the IMPLEMENT stage's role contract — that is what this sandbox boundary is for.
 * @param {string} stage
 * @param {string} prompt
 * @param {string} cwd
 * @param {string} lastmsgPath  path for -o (last assistant message output)
 * @param {string | undefined} repoRoot  main repo root; enables --add-dir <repoRoot>/.git under workspace-write
 * @param {string | undefined} model  optional model override (-m)
 * @returns {string[]}
 */
export function buildCodexArgs(stage, prompt, cwd, lastmsgPath, repoRoot, model) {
  // Defensive: cwd must be absolute so codex's workspace-write root is unambiguous.
  // A relative cwd can resolve to the spawn cwd (main root), leaking write access.
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error(`buildCodexArgs: cwd must be an absolute path, got: ${JSON.stringify(cwd)}`);
  }
  const args = [prompt, '--json', '-o', lastmsgPath, '-C', cwd, '-s', stageSandbox(stage)];
  if (stageSandbox(stage) === 'workspace-write') {
    args.push('-c', 'sandbox_workspace_write.network_access=true');
    if (repoRoot) args.push('--add-dir', `${repoRoot}/.git`);
  }
  if (model) args.push('-m', model);
  return args;
}

/**
 * Build argv for `claude ...` (everything after 'claude').
 * Regression guard: must produce the same argv as the original runStage.
 * @param {string} stage
 * @param {string} prompt
 * @param {string | null} resumeSessionId
 * @returns {string[]}
 */
export function buildClaudeArgs(stage, prompt, resumeSessionId) {
  const { agent, permissionMode, allowedTools } = stagePermissions(stage);
  const args = [
    '-p', prompt,
    '--agent', agent,
    '--output-format', 'json',
    '--permission-mode', permissionMode,
    '--settings', INNER_SETTINGS_PATH,
  ];
  if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

/**
 * Remove YAML frontmatter (---\n…\n---\n) from the top of a markdown string.
 * Returns the input unchanged when no frontmatter is found.
 * @param {string} mdText
 * @returns {string}
 */
export function stripFrontmatter(mdText) {
  if (!mdText || typeof mdText !== 'string') return mdText ?? '';
  const m = mdText.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : mdText;
}

/**
 * Prepend the agent role body to the stage prompt (codex doesn't read
 * .claude/agents/*.md automatically; we inline to share the single source).
 * @param {string} agentBody   frontmatter-stripped .md content
 * @param {string} stagePrompt
 * @returns {string}
 */
export function buildCodexPrompt(agentBody, stagePrompt) {
  if (!agentBody) return stagePrompt;
  return `${agentBody.trimEnd()}\n\n${stagePrompt}`;
}

/**
 * Parse the codex session/thread id from the --json JSONL stream (stdout).
 * Accepts both persisted rollout shape (`session_meta.payload.id`) and exec
 * stream shape (`session_configured.session_id`).
 * Returns null if not found.
 * @param {string} jsonlText
 * @returns {string | null}
 */
export function parseCodexSessionId(jsonlText) {
  if (!jsonlText || typeof jsonlText !== 'string') return null;
  for (const line of jsonlText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      const payload = rec?.payload && typeof rec.payload === 'object' ? rec.payload : {};
      if (rec?.type === 'session_meta') {
        if (typeof payload.id === 'string' && payload.id) return payload.id;
        if (typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
      }
      if (rec?.type === 'session_configured') {
        if (typeof rec.session_id === 'string' && rec.session_id) return rec.session_id;
        if (typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId;
        if (typeof payload.session_id === 'string' && payload.session_id) return payload.session_id;
        if (typeof payload.sessionId === 'string' && payload.sessionId) return payload.sessionId;
        if (typeof rec.thread_id === 'string' && rec.thread_id) return rec.thread_id;
        if (typeof rec.threadId === 'string' && rec.threadId) return rec.threadId;
        if (typeof payload.thread_id === 'string' && payload.thread_id) return payload.thread_id;
        if (typeof payload.threadId === 'string' && payload.threadId) return payload.threadId;
      }
      if (rec?.type === 'thread.started') {
        if (typeof rec.thread_id === 'string' && rec.thread_id) return rec.thread_id;
        if (typeof rec.threadId === 'string' && rec.threadId) return rec.threadId;
        if (typeof payload.thread_id === 'string' && payload.thread_id) return payload.thread_id;
        if (typeof payload.threadId === 'string' && payload.threadId) return payload.threadId;
      }
    } catch { /* skip malformed lines */ }
  }
  return null;
}

/**
 * Parse Codex cost evidence from JSONL. Explicit USD cost wins when present;
 * otherwise token usage is priced from apps/web/db/pricing.json when the model
 * is known. Unknown models keep token evidence but leave cost null.
 * @param {string} jsonlText
 * @returns {{ costUsd: number|null, source: string|null, model: string|null, tokenUsage: { input_tokens: number, cached_input_tokens: number, output_tokens: number, reasoning_output_tokens: number }|null }}
 */
export function parseCodexCostReport(jsonlText) {
  if (!jsonlText || typeof jsonlText !== 'string') {
    return { costUsd: null, source: null, model: null, tokenUsage: null };
  }
  let explicitCost = null;
  let turnContextModel = null;
  let sessionMetaModel = null;
  let turnCompletedUsage = null;
  let tokenCountUsage = null;

  for (const line of jsonlText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      const payload = rec?.payload && typeof rec.payload === 'object' ? rec.payload : {};
      for (const v of [rec.total_cost_usd, rec.cost_usd, payload.total_cost_usd, payload.cost_usd]) {
        const cost = finiteNumber(v);
        if (cost !== null && explicitCost === null) explicitCost = cost;
      }
      if (rec?.type === 'turn_context' && typeof payload.model === 'string' && payload.model) {
        turnContextModel = payload.model;
      }
      if (rec?.type === 'session_meta' && typeof payload.model === 'string' && payload.model) {
        sessionMetaModel = payload.model;
      }
      if (rec?.type === 'turn.completed') {
        turnCompletedUsage = addCodexTokenUsage(turnCompletedUsage, normalizeCodexTokenUsage(rec.usage ?? payload.usage));
      }
      const tokenCount = rec?.type === 'event_msg' && payload.type === 'token_count'
        ? payload.info?.total_token_usage
        : rec?.type === 'token_count'
          ? rec.info?.total_token_usage
          : null;
      const normalizedTokenCount = normalizeCodexTokenUsage(tokenCount);
      if (normalizedTokenCount) {
        tokenCountUsage = normalizedTokenCount;
      }
    } catch { /* skip malformed lines */ }
  }
  const model = turnContextModel ?? sessionMetaModel ?? null;
  const tokenUsage = turnCompletedUsage ?? tokenCountUsage ?? null;
  const tokenSource = turnCompletedUsage ? CODEX_TURN_USAGE_SOURCE : tokenCountUsage ? CODEX_TOKEN_COUNT_USAGE_SOURCE : null;
  if (explicitCost !== null) {
    return { costUsd: explicitCost, source: CODEX_EXPLICIT_COST_SOURCE, model, tokenUsage };
  }
  if (!tokenUsage || !tokenSource) {
    return { costUsd: null, source: null, model, tokenUsage: null };
  }
  const derivedCost = codexCostForUsage(model, tokenUsage);
  return {
    costUsd: derivedCost,
    source: derivedCost === null ? `${tokenSource}.unpriced` : tokenSource,
    model,
    tokenUsage,
  };
}

/**
 * Parse a USD cost from codex JSONL. Explicit cost is preferred; otherwise
 * returns a token-derived cost when the stream has usage plus a priceable model.
 * @param {string} jsonlText
 * @returns {number | null}
 */
export function parseCodexCostUsd(jsonlText) {
  return parseCodexCostReport(jsonlText).costUsd;
}

/**
 * Parse --backend and --backend-<stage> flags from an argv array.
 * Stage keys are uppercased (PLAN, IMPLEMENT, …).
 * @param {string[]} argv
 * @returns {{ global: string | null, stages: Record<string, string> }}
 */
export function parseBackendFlags(argv) {
  const result = { global: null, stages: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--backend') { result.global = argv[i + 1] ?? null; i++; }
    else {
      const m = arg.match(/^--backend-([a-z-]+)$/);
      if (m) { result.stages[m[1].replaceAll('-', '_').toUpperCase()] = argv[i + 1] ?? null; i++; }
    }
  }
  return result;
}

/**
 * Resolve the backend for a given stage from parsed flags.
 * Stage-specific override > global override > default.
 * @param {string} stage
 * @param {{ global: string | null, stages: Record<string, string> }} flags
 * @returns {string}
 */
export function selectBackend(stage, flags, fallback = 'claude') {
  if (flags.stages[stage] != null) return flags.stages[stage];
  if (flags.global != null) return flags.global;
  return fallback;
}

/**
 * Resolve the fallback backend for a resumed run by finding the most-recent
 * non-null `backend` value across all manifest stages.
 * Returns null when no backend has been recorded yet.
 * @param {Array<{ backend?: string | null }>} stages
 * @returns {string | null}
 */
export function resolveResumeBackend(stages) {
  if (!Array.isArray(stages)) return null;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].backend != null) return stages[i].backend;
  }
  return null;
}

/**
 * Parse `git status --porcelain` output to detect tracked dirty files.
 * Untracked entries (??) are excluded to avoid false positives from
 * node_modules, build artefacts, and other untracked noise.
 *
 * This is the pure core of the MERGE-before backstop (issue #39, ADR 0014 §3):
 * if the main working tree has tracked dirty files after an IMPLEMENT stage,
 * the sandbox write-isolation has been breached and the driver must escalate
 * instead of landing the branch.
 *
 * @param {string} porcelainText - stdout from `git status --porcelain`
 * @returns {{ dirty: boolean, paths: string[] }}
 */
export function detectMainDirty(porcelainText) {
  if (!porcelainText || typeof porcelainText !== 'string') return { dirty: false, paths: [] };
  const paths = [];
  for (const line of porcelainText.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // --porcelain format: "XY <path>" — XY is 2 status chars, then a space.
    // Lines starting with "??" are untracked — skip them.
    if (trimmed.startsWith('??')) continue;
    const filePath = trimmed.slice(3); // skip "XY "
    if (filePath) paths.push(filePath);
  }
  return { dirty: paths.length > 0, paths };
}

/** True when IMPLEMENT returned IMPL_DONE but the worktree HEAD did not advance (zero new commits). */
export function detectHollowImplement({ verdict, baseSha, headSha }) {
  if (verdict !== 'IMPL_DONE') return false;
  if (!baseSha || !headSha) return false;
  return baseSha === headSha;
}
