// inner-loop-backends.mjs — stage permission tables + backend adapter pure functions
// (ADR 0013 §機構詳細 + ADR 0014). Separated from inner-loop.mjs to keep that file
// under the 500-line guard. All exports are pure functions; no spawnSync here.

/**
 * Permission flags per stage (ADR 0013 §機構詳細).
 * --bare / --dangerously-skip-permissions must never be used (hooks must fire).
 * @param {string} stage
 * @returns {{ agent: string, permissionMode: string, allowedTools?: string[] }}
 */
export function stagePermissions(stage) {
  switch (stage) {
    case 'PLAN':
      return { agent: 'planner', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    case 'IMPLEMENT':
      return {
        agent: 'implementer',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(node *)'],
      };
    case 'REVIEW':
      // No receipt.mjs allowedTool: the driver stamps receipts itself (buildReceiptArgs).
      return { agent: 'reviewer', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    case 'VERIFY':
      return {
        agent: 'verifier',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(node *)'],
      };
    case 'TRIAGE':
      return { agent: 'test-triage', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
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
  return stage === 'PLAN' ? repoRoot : worktreePath;
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
 * IMPLEMENT → workspace-write (edits files); all others → read-only.
 * @param {string} stage
 * @returns {'workspace-write' | 'read-only'}
 */
export function stageSandbox(stage) {
  return stage === 'IMPLEMENT' ? 'workspace-write' : 'read-only';
}

/**
 * Build argv for `codex exec <prompt> ...` (everything after 'exec').
 * NEVER includes --dangerously-bypass-* or --ephemeral.
 * @param {string} stage
 * @param {string} prompt
 * @param {string} cwd
 * @param {string} lastmsgPath  path for -o (last assistant message output)
 * @param {string | undefined} model  optional model override (-m)
 * @returns {string[]}
 */
export function buildCodexArgs(stage, prompt, cwd, lastmsgPath, model) {
  const args = [prompt, '--json', '-o', lastmsgPath, '-C', cwd, '-s', stageSandbox(stage)];
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
 * Parse the codex session/rollout id from the --json JSONL stream (stdout).
 * Looks for a `session_meta` record with payload.id — the same format used
 * in ~/.codex/sessions rollout files (see ingest/providers/codex.ts).
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
      if (rec?.type === 'session_meta' && typeof rec.payload?.id === 'string') return rec.payload.id;
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
      const m = arg.match(/^--backend-([a-z]+)$/);
      if (m) { result.stages[m[1].toUpperCase()] = argv[i + 1] ?? null; i++; }
    }
  }
  return result;
}

/**
 * Resolve the backend for a given stage from parsed flags.
 * Stage-specific override > global override > default ('codex').
 * @param {string} stage
 * @param {{ global: string | null, stages: Record<string, string> }} flags
 * @returns {string}
 */
export function selectBackend(stage, flags) {
  if (flags.stages[stage] != null) return flags.stages[stage];
  if (flags.global != null) return flags.global;
  return 'codex';
}
