#!/usr/bin/env node
// CLI: node scripts/inner-loop.mjs <issue#> [--dry-run]
// inner loop driver — a code state machine that drives headless named agents
// (planner/implementer/reviewer/verifier/test-triage) through
// PLAN → IMPLEMENT → REVIEW → VERIFY → (RED→TRIAGE) → MERGE for one issue.
// ADR 0013: https://... (adr/0013-inner-loop-driver.md) — driver is code, not
// an agent, because stage transitions are deterministic (verdict-driven), not
// judgment calls.
//
// Pure logic (verdict parsing, state transitions, manifest entries) is exported
// for unit testing. spawnSync calls to `claude`/`git`/`gh` are isolated in thin
// wrapper functions so tests can inject fakes without spawning real processes.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { buildStagePrompt } from './inner-loop-prompts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Constants ---

export const VALID_VERDICT_TOKENS = [
  'PLAN_READY',
  'ESCALATE',
  'IMPL_DONE',
  'PASS',
  'CHANGES',
  'GREEN',
  'RED',
  'KNOWN',
  'NOVEL',
];

// Bounded retries: review⇄implement (CHANGES) and triage⇄implement (KNOWN)
// share one cycle counter — "review⇄implement は 2 周まで" (ADR 0013 §1).
export const MAX_CYCLES = 2;

// --- Pure / testable exports ---

/**
 * Parse the VERDICT token from a stage's result text.
 * Looks for a line matching `VERDICT: <TOKEN>` (last match wins, per ADR
 * "envelope の result 末尾から parse"). Returns null if absent or unparsable
 * — callers must treat null as ESCALATE ("VERDICT が無い・parse 不能もエスカレーション").
 *
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

/**
 * State transition table. Given the current state, the verdict just parsed,
 * and the current cycle count (review⇄implement / triage⇄implement retries
 * so far), returns the next state and the updated cycle count.
 *
 * Terminal states: MERGE (success path continues to driver-run merge.mjs,
 * modeled here as state 'MERGE'), ESCALATE, DONE.
 *
 * @param {string} state
 * @param {string | null} verdict
 * @param {number} cycles
 * @returns {{ next: string, cycles: number }}
 */
export function nextState(state, verdict, cycles = 0) {
  if (verdict === null) {
    return { next: 'ESCALATE', cycles };
  }

  switch (state) {
    case 'PLAN':
      if (verdict === 'PLAN_READY') return { next: 'IMPLEMENT', cycles };
      return { next: 'ESCALATE', cycles };

    case 'IMPLEMENT':
      if (verdict === 'IMPL_DONE') return { next: 'REVIEW', cycles };
      return { next: 'ESCALATE', cycles };

    case 'REVIEW':
      if (verdict === 'PASS') return { next: 'VERIFY', cycles };
      if (verdict === 'CHANGES') {
        const next = cycles + 1;
        if (next > MAX_CYCLES) return { next: 'ESCALATE', cycles: next };
        return { next: 'IMPLEMENT', cycles: next };
      }
      return { next: 'ESCALATE', cycles };

    case 'VERIFY':
      if (verdict === 'GREEN') return { next: 'MERGE', cycles };
      if (verdict === 'RED') return { next: 'TRIAGE', cycles };
      return { next: 'ESCALATE', cycles };

    case 'TRIAGE':
      if (verdict === 'KNOWN') {
        const next = cycles + 1;
        if (next > MAX_CYCLES) return { next: 'ESCALATE', cycles: next };
        return { next: 'IMPLEMENT', cycles: next };
      }
      if (verdict === 'NOVEL') return { next: 'ESCALATE', cycles };
      return { next: 'ESCALATE', cycles };

    default:
      return { next: 'ESCALATE', cycles };
  }
}

/**
 * Build one run-manifest entry (ADR 0013 §2: `.lathe/runs/issue-<n>.json`).
 * @param {{ stage: string, sessionId: string | null, verdict: string | null, costUsd: number | null, ts?: string }} args
 * @returns {{ stage: string, session_id: string | null, verdict: string | null, cost_usd: number | null, ts: string }}
 */
export function buildManifestEntry({ stage, sessionId, verdict, costUsd, ts }) {
  return {
    stage,
    session_id: sessionId ?? null,
    verdict: verdict ?? null,
    cost_usd: costUsd ?? null,
    ts: ts ?? new Date().toISOString(),
  };
}

/**
 * Read an existing manifest file (if present) and return its stages array,
 * or an empty array if the file doesn't exist / is malformed.
 * @param {string} manifestPath
 * @returns {Array<object>}
 */
export function readManifestStages(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.stages) ? data.stages : [];
  } catch {
    return [];
  }
}

/**
 * Build the full manifest object for writing.
 * @param {number} issueNumber
 * @param {Array<object>} stages
 * @returns {{ issue: number, stages: Array<object> }}
 */
export function buildManifest(issueNumber, stages) {
  return { issue: issueNumber, stages };
}

/**
 * Permission flags per stage, per ADR 0013 §機構詳細:
 * implementer = acceptEdits (worktree cwd, can edit); read-only stages
 * (planner/reviewer/verifier/test-triage) = dontAsk + allowedTools for the
 * Bash they need (verify/review need to run pnpm/node/git commands).
 * `--bare` and `--dangerously-skip-permissions` must never be used (ADR: hooks
 * must fire).
 *
 * @param {string} stage
 * @returns {{ agent: string, permissionMode: string, allowedTools?: string[] }}
 */
export function stagePermissions(stage) {
  switch (stage) {
    case 'PLAN':
      return { agent: 'planner', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    case 'IMPLEMENT':
      return { agent: 'implementer', permissionMode: 'acceptEdits' };
    case 'REVIEW':
      return {
        agent: 'reviewer',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(node scripts/receipt.mjs *)'],
      };
    case 'VERIFY':
      return {
        agent: 'verifier',
        permissionMode: 'dontAsk',
        allowedTools: [
          'Read',
          'Grep',
          'Glob',
          'Bash(git *)',
          'Bash(pnpm *)',
          'Bash(node *)',
          'Bash(node scripts/receipt.mjs *)',
        ],
      };
    case 'TRIAGE':
      return { agent: 'test-triage', permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git *)'] };
    default:
      throw new Error(`stagePermissions: unknown stage "${stage}"`);
  }
}

/**
 * cwd for a stage: PLAN runs at repo root (it needs main's full context before
 * the worktree exists); every other agent stage runs inside the issue worktree.
 * @param {string} stage
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {string}
 */
export function stageCwd(stage, repoRoot, worktreePath) {
  return stage === 'PLAN' ? repoRoot : worktreePath;
}

// --- Side-effectful helpers (thin wrappers; tests inject fakes instead) ---

function die(msg) {
  process.stderr.write(`inner-loop: error: ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`[inner-loop] ${msg}\n`);
}

/**
 * Fetch issue via `gh issue view`. Isolated for injectability.
 * @param {number} issueNumber
 * @returns {{ number: number, title: string, body: string }}
 */
function fetchIssue(issueNumber) {
  const result = spawnSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--json', 'number,title,body'],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    die(`gh issue view failed: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    die(`could not parse gh issue view output: ${e.message}`);
  }
}

/**
 * Create the issue worktree. Errors (does not overwrite) if it already exists.
 * @param {number} issueNumber
 * @returns {{ path: string, branch: string }}
 */
function prepareWorktree(issueNumber) {
  const branch = `inner/issue-${issueNumber}`;
  const path = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issueNumber}`);
  if (existsSync(path)) {
    die(`worktree already exists at ${path} — refusing to overwrite. Remove it first if you intend to restart.`);
  }
  const result = spawnSync('git', ['worktree', 'add', path, '-b', branch, 'main'], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    die(`git worktree add failed for ${path}`);
  }
  return { path, branch };
}

/**
 * Run one stage via `claude -p ... --agent <name> --output-format json`.
 * Returns the parsed envelope ({ session_id, result, total_cost_usd, ... }).
 * @param {string} stage
 * @param {string} prompt
 * @param {string} cwd
 * @param {string | null} resumeSessionId
 * @returns {object}
 */
function runStage(stage, prompt, cwd, resumeSessionId = null) {
  const { agent, permissionMode, allowedTools } = stagePermissions(stage);
  const args = ['-p', prompt, '--agent', agent, '--output-format', 'json', '--permission-mode', permissionMode];
  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }
  const result = spawnSync('claude', args, { encoding: 'utf8', cwd, maxBuffer: 1e8 });
  if (result.status !== 0 && !result.stdout) {
    die(`claude -p failed for stage ${stage}: ${result.stderr || 'no output'}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    die(`could not parse claude envelope for stage ${stage}: ${e.message}\nstdout: ${result.stdout}`);
  }
}

function manifestPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.json`);
}

function appendManifestEntry(issueNumber, entry) {
  const path = manifestPathFor(issueNumber);
  mkdirSync(dirname(path), { recursive: true });
  const stages = readManifestStages(path);
  stages.push(entry);
  writeFileSync(path, JSON.stringify(buildManifest(issueNumber, stages), null, 2) + '\n', 'utf8');
}

function writeEscalation(issueNumber, stage, verdict, resultExcerpt) {
  const path = join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.escalation.md`);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `# escalation — issue #${issueNumber}`,
    '',
    `stage: ${stage}`,
    `verdict: ${verdict ?? '(none/unparsable)'}`,
    `ts: ${new Date().toISOString()}`,
    '',
    '## result excerpt',
    '',
    '```',
    (resultExcerpt ?? '').slice(-4000),
    '```',
    '',
  ].join('\n');
  appendFileSync(path, body, 'utf8');
  const commentResult = spawnSync(
    'gh',
    ['issue', 'comment', String(issueNumber), '--body', `inner-loop escalated at stage ${stage} (verdict: ${verdict ?? 'none'}). See ${path}`],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (commentResult.status !== 0) {
    log(`warning: gh issue comment failed (continuing) for issue #${issueNumber}`);
  }
}

function rebaseWorktree(worktreePath) {
  const result = spawnSync('git', ['-C', worktreePath, 'rebase', 'main'], { stdio: 'inherit' });
  return result.status === 0;
}

function runMerge(branch) {
  const result = spawnSync('node', ['scripts/merge.mjs', branch], { stdio: 'inherit', cwd: REPO_ROOT });
  return result.status === 0;
}

function cleanupWorktree(worktreePath, branch) {
  spawnSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: REPO_ROOT, stdio: 'inherit' });
  spawnSync('git', ['branch', '-D', branch], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const issueArg = args.find((a) => !a.startsWith('--'));
  const issueNumber = Number(issueArg);

  if (!issueArg || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    die('usage: node scripts/inner-loop.mjs <issue#> [--dry-run]');
  }

  if (dryRun) {
    log(`dry-run: would fetch issue #${issueNumber} via gh issue view`);
    log(`dry-run: would create worktree .claude/worktrees/inner-issue-${issueNumber} on branch inner/issue-${issueNumber}`);
    const stages = ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE'];
    for (const stage of stages) {
      if (stage === 'MERGE') {
        log('dry-run: MERGE — node scripts/merge.mjs inner/issue-<n> (from repo root)');
        continue;
      }
      const { agent, permissionMode, allowedTools } = stagePermissions(stage);
      const cwd = stageCwd(stage, REPO_ROOT, `.claude/worktrees/inner-issue-${issueNumber}`);
      const promptPreview = buildStagePrompt(stage, {
        issueNumber,
        issueTitle: '<title>',
        issueBody: '<body>',
        plan: '<plan>',
        headSha: '<sha>',
        verifyResult: '<verify result>',
      });
      log(`dry-run: stage=${stage} agent=${agent} permission-mode=${permissionMode} allowedTools=${(allowedTools || []).join(',')} cwd=${cwd}`);
      log(`dry-run: prompt preview:\n${promptPreview}\n`);
    }
    log('dry-run: transition plan — PLAN_READY->IMPLEMENT, IMPL_DONE->REVIEW, REVIEW PASS->VERIFY / CHANGES->IMPLEMENT (max 2 cycles), VERIFY GREEN->MERGE / RED->TRIAGE, TRIAGE KNOWN->IMPLEMENT / NOVEL->ESCALATE, missing/unparsable VERDICT->ESCALATE');
    process.exit(0);
  }

  const issue = fetchIssue(issueNumber);
  const { path: worktreePath, branch } = prepareWorktree(issueNumber);

  let state = 'PLAN';
  let cycles = 0;
  let plan = '';
  let feedback = null;
  let headSha = null;
  let verifyResult = '';

  while (state !== 'MERGE' && state !== 'ESCALATE' && state !== 'DONE') {
    const cwd = stageCwd(state, REPO_ROOT, worktreePath);

    if (state === 'REVIEW' || state === 'VERIFY') {
      // Capture the current worktree HEAD sha for receipt issuance (post rebase for REVIEW).
      if (state === 'REVIEW') {
        log(`rebasing worktree onto main before review (issue #${issueNumber})`);
        if (!rebaseWorktree(worktreePath)) {
          writeEscalation(issueNumber, 'REVIEW', 'REBASE_CONFLICT', 'git rebase main failed in worktree');
          state = 'ESCALATE';
          break;
        }
      }
      const shaResult = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      headSha = shaResult.stdout.trim();
    }

    const prompt = buildStagePrompt(state, {
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      plan,
      feedback,
      headSha,
      verifyResult,
    });

    log(`stage=${state} cwd=${cwd} — spawning claude -p`);
    const envelope = runStage(state, prompt, cwd);
    const verdict = parseVerdict(envelope.result);

    appendManifestEntry(issueNumber, buildManifestEntry({
      stage: state,
      sessionId: envelope.session_id ?? null,
      verdict,
      costUsd: envelope.total_cost_usd ?? null,
    }));

    if (verdict === null) {
      writeEscalation(issueNumber, state, null, envelope.result ?? '');
      state = 'ESCALATE';
      break;
    }

    if (state === 'PLAN' && verdict === 'PLAN_READY') {
      plan = envelope.result;
    }
    if (state === 'REVIEW' && verdict === 'CHANGES') {
      feedback = envelope.result;
    }
    if (state === 'VERIFY' && verdict === 'RED') {
      verifyResult = envelope.result;
    }
    if (state === 'TRIAGE' && verdict === 'KNOWN') {
      feedback = envelope.result;
    }

    const { next, cycles: nextCycles } = nextState(state, verdict, cycles);
    if (next === 'ESCALATE') {
      writeEscalation(issueNumber, state, verdict, envelope.result ?? '');
    }
    log(`stage=${state} verdict=${verdict} -> next=${next} (cycles=${nextCycles})`);
    state = next;
    cycles = nextCycles;
  }

  if (state === 'ESCALATE') {
    die(`escalated — see .lathe/runs/issue-${issueNumber}.escalation.md`);
  }

  // state === 'MERGE'
  log(`merging branch ${branch} onto main`);
  if (!runMerge(branch)) {
    writeEscalation(issueNumber, 'MERGE', null, 'node scripts/merge.mjs failed');
    die(`merge failed — see .lathe/runs/issue-${issueNumber}.escalation.md`);
  }

  cleanupWorktree(worktreePath, branch);
  log(`done — issue #${issueNumber} merged onto main.`);
  process.exit(0);
}
