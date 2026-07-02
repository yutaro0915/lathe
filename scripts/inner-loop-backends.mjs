// inner-loop-backends.mjs — stage permission tables + backend adapter pure functions
// (ADR 0013 §機構詳細 + ADR 0014). Separated from inner-loop.mjs to keep that file
// under the 500-line guard. All exports are pure functions; no spawnSync here.

import { isAbsolute } from 'node:path';

const READ_ONLY_GH_ISSUE_TOOLS = [
  'Bash(gh issue view *)',
  'Bash(gh issue list *)',
];

/**
 * Permission flags per stage (ADR 0013 §機構詳細).
 * --bare / --dangerously-skip-permissions must never be used (hooks must fire).
 * @param {string} stage
 * @returns {{ agent: string, permissionMode: string, allowedTools?: string[] }}
 */
export function stagePermissions(stage) {
  switch (stage) {
    case 'RESEARCH':
      return {
        agent: 'researcher',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', ...READ_ONLY_GH_ISSUE_TOOLS],
      };
    case 'PLAN':
      return { agent: 'planner', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    case 'PLAN_REVIEW':
      // ADR 0016: PLAN-REVIEW is a plan audit by the reviewer role (separation
      // of author and approver), not the planner reviewing its own output.
      return {
        agent: 'reviewer',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', ...READ_ONLY_GH_ISSUE_TOOLS],
      };
    case 'IMPLEMENT':
      // IMPLEMENT needs env-prefixed and compound verification/commit commands
      // just like VERIFY/TRIAGE (#44/#45). Containment is worktree cwd, the
      // implementer role contract, the main-dirty backstop, and the merge gate.
      return {
        agent: 'implementer',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      };
    case 'REVIEW':
      // No receipt.mjs allowedTool: the driver stamps receipts itself (buildReceiptArgs).
      return { agent: 'reviewer', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    case 'VERIFY':
      // Bash is blanket, not narrowed to git/pnpm/node: verification idioms
      // (`; echo EXIT=$?`, `2>&1 | tail`, `TZ=UTC node …`) compose arbitrary
      // commands and structurally conflict with fine-grained allowlists
      // (#36/#44). Containment is worktree cwd, the read-only role contract,
      // the main-dirty backstop, and the merge gate — not the allowlist.
      return {
        agent: 'verifier',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      };
    case 'TRIAGE':
      // Same rationale as VERIFY above (#36/#44): triage reruns verification
      // probes, so it needs the same blanket Bash.
      return { agent: 'test-triage', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash'] };
    default:
      throw new Error(`stagePermissions: unknown stage "${stage}"`);
  }
}

/**
 * cwd for a stage: PLAN runs at repo root; every other stage in the worktree.
 * @param {string} stage
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {string}
 */
export function stageCwd(stage, repoRoot, worktreePath) {
  return ['RESEARCH', 'PLAN', 'PLAN_REVIEW'].includes(stage) ? repoRoot : worktreePath;
}

// stage -> [receipt.mjs step, LATHE_AGENT, valid verdicts] — driver stamps
// receipts itself (env-prefixed agent commands silently fail Bash allowlist).
const RECEIPT_STAGE_MAP = {
  REVIEW: ['review', 'reviewer', ['PASS', 'CHANGES']],
  VERIFY: ['verify', 'verifier', ['GREEN', 'RED']],
};

/**
 * Build argv + env for stamping a receipt from a stage verdict.
 * Only REVIEW (PASS/CHANGES) and VERIFY (GREEN/RED) are receipt-eligible.
 * @returns {{ command: string, args: string[], env: { LATHE_AGENT: string } } | null}
 */
export function buildReceiptArgs(stage, sha, verdict) {
  const mapped = RECEIPT_STAGE_MAP[stage];
  if (!mapped) return null;
  const [step, agent, validVerdicts] = mapped;
  if (!validVerdicts.includes(verdict)) return null;
  return { command: 'node', args: ['scripts/receipt.mjs', step, sha, verdict], env: { LATHE_AGENT: agent } };
}

// --- Backend adapter pure functions (ADR 0014) ---

/**
 * Sandbox mode for a stage's codex exec invocation.
 * IMPLEMENT/VERIFY/TRIAGE -> workspace-write; PLAN/REVIEW -> read-only.
 * VERIFY needs build/test writes and localhost. TRIAGE may rerun probes.
 * @param {string} stage
 * @returns {'workspace-write' | 'read-only'}
 */
export function stageSandbox(stage) {
  return ['IMPLEMENT', 'VERIFY', 'TRIAGE'].includes(stage) ? 'workspace-write' : 'read-only';
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
 * protecting main is already the job of merge.mjs's receipt gate plus the
 * IMPLEMENT stage's role contract — that is what this sandbox boundary is for.
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
  const args = ['-p', prompt, '--agent', agent, '--output-format', 'json', '--permission-mode', permissionMode];
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
 * Parse an explicit USD cost from codex JSONL when the stream provides one.
 * Codex exec commonly omits dollar cost, so callers must tolerate null.
 * @param {string} jsonlText
 * @returns {number | null}
 */
export function parseCodexCostUsd(jsonlText) {
  if (!jsonlText || typeof jsonlText !== 'string') return null;
  for (const line of jsonlText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      const payload = rec?.payload && typeof rec.payload === 'object' ? rec.payload : {};
      for (const v of [rec.total_cost_usd, rec.cost_usd, payload.total_cost_usd, payload.cost_usd]) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
    } catch { /* skip malformed lines */ }
  }
  return null;
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
export function selectBackend(stage, flags) {
  if (flags.stages[stage] != null) return flags.stages[stage];
  if (flags.global != null) return flags.global;
  if (stage === 'VERIFY') return 'claude';
  return 'codex';
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

/**
 * Validate a plan-loop `Depends-on:` value (ADR 0015/0016: Depends-on is a
 * machine-readable contract that decides run eligibility, not free text).
 *
 * A missing/unparseable line is a parser failure, not an empty dependency —
 * silently rounding "absent" down to "no deps" would let plan-loop issue
 * implementation issues with unverified dependency claims. Plans with no
 * real dependency must say so explicitly with the `none` marker.
 *
 * @param {string | null} rawValue - the captured group after "Depends-on:",
 *   or null if the line itself was not found in the plan text.
 * @returns {{ ok: true, dependsOn: string } | { ok: false, error: string }}
 */
export function parseDependsOnLine(rawValue) {
  if (rawValue == null) {
    return { ok: false, error: 'approved plan is missing required "Depends-on:" line (use "Depends-on: none" if there are no dependencies)' };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'approved plan has an empty "Depends-on:" value (use "Depends-on: none" if there are no dependencies)' };
  }
  if (/^none$/i.test(trimmed)) {
    return { ok: true, dependsOn: '' };
  }
  return { ok: true, dependsOn: trimmed };
}
