#!/usr/bin/env node
// CLI: node scripts/inner-loop.mjs <issue#> [--dry-run] [--backend claude|codex]
//      [--backend-<stage> claude|codex]
// inner loop driver — code state machine driving headless named agents
// (planner/implementer/reviewer/verifier/test-triage) through
// PLAN → IMPLEMENT → REVIEW → VERIFY → (RED→TRIAGE) → MERGE for one issue.
// ADR 0013 (adr/0013-inner-loop-driver.md) / ADR 0014 (backend adapter).
//
// Pure logic is exported for unit testing; spawnSync wrappers are isolated so
// tests can inject fakes. Backend pure functions live in inner-loop-backends.mjs.

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
 * Build one run-manifest entry (ADR 0013 §2 + ADR 0014 backend field).
 * @param {{ stage: string, sessionId: string|null, verdict: string|null, costUsd: number|null, durationMs?: number|null, ts?: string, backend?: string|null }} p
 */
export function buildManifestEntry({ stage, sessionId, verdict, costUsd, durationMs, ts, backend }) {
  return {
    stage,
    session_id: sessionId ?? null,
    verdict: verdict ?? null,
    cost_usd: costUsd ?? null,
    duration_ms: durationMs ?? null,
    ts: ts ?? new Date().toISOString(),
    backend: backend ?? null,
  };
}

// Read existing manifest (if present), returning stages array or [].
export function readManifestStages(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.stages) ? data.stages : [];
  } catch { return []; }
}

// Build the full manifest object for writing.
export function buildManifest(issueNumber, stages) {
  return { issue: issueNumber, stages };
}

// Also export backend pure functions so tests can import from one place.
export {
  stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt,
  parseCodexSessionId, parseCodexCostUsd, parseBackendFlags, selectBackend,
};

// --- Side-effectful helpers ---

function die(msg) { process.stderr.write(`inner-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[inner-loop] ${msg}\n`); }

function fetchIssue(issueNumber) {
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,body'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) die(`gh issue view failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout); } catch (e) { die(`could not parse gh issue view output: ${e.message}`); }
}

function prepareWorktree(issueNumber) {
  const branch = `inner/issue-${issueNumber}`;
  const path = join(REPO_ROOT, '.claude', 'worktrees', `inner-issue-${issueNumber}`);
  if (existsSync(path)) die(`worktree already exists at ${path} — refusing to overwrite. Remove it first if you intend to restart.`);
  const r = spawnSync('git', ['worktree', 'add', path, '-b', branch, 'main'], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.status !== 0) die(`git worktree add failed for ${path}`);
  return { path, branch };
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

function appendManifestEntry(issueNumber, entry) {
  const p = manifestPathFor(issueNumber);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildManifest(issueNumber, stages), null, 2) + '\n', 'utf8');
}

function writeEscalation(issueNumber, stage, verdict, resultExcerpt) {
  const p = join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.escalation.md`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, [
    `# escalation — issue #${issueNumber}`, '',
    `stage: ${stage}`, `verdict: ${verdict ?? '(none/unparsable)'}`, `ts: ${new Date().toISOString()}`, '',
    '## result excerpt', '', '```', (resultExcerpt ?? '').slice(-4000), '```', '',
  ].join('\n'), 'utf8');
  const cr = spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body',
    `inner-loop escalated at stage ${stage} (verdict: ${verdict ?? 'none'}). See ${p}`],
    { cwd: REPO_ROOT, stdio: 'inherit' });
  if (cr.status !== 0) log(`warning: gh issue comment failed (continuing) for issue #${issueNumber}`);
}

function rebaseWorktree(wt) {
  return spawnSync('git', ['-C', wt, 'rebase', 'main'], { stdio: 'inherit' }).status === 0;
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

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const issueArg = args.find((a) => !a.startsWith('--'));
  const issueNumber = Number(issueArg);
  const backendFlags = parseBackendFlags(args);

  if (!issueArg || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    die('usage: node scripts/inner-loop.mjs <issue#> [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]');
  }

  if (dryRun) {
    log(`dry-run: would fetch issue #${issueNumber} via gh issue view`);
    log(`dry-run: would create worktree .claude/worktrees/inner-issue-${issueNumber} on branch inner/issue-${issueNumber}`);
    const wtPath = `.claude/worktrees/inner-issue-${issueNumber}`;
    for (const stage of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']) {
      if (stage === 'MERGE') {
        log('dry-run: MERGE — node scripts/merge.mjs inner/issue-<n> (from repo root)');
        continue;
      }
      const backend = selectBackend(stage, backendFlags);
      const { agent, permissionMode, allowedTools } = stagePermissions(stage);
      const cwd = stageCwd(stage, REPO_ROOT, wtPath);
      const promptPreview = buildStagePrompt(stage, {
        issueNumber, issueTitle: '<title>', issueBody: '<body>',
        plan: '<plan>', headSha: '<sha>', verifyResult: '<verify result>',
      });
      if (backend === 'codex') {
        const sb = stageSandbox(stage);
        const lm = join(tmpdir(), `lathe-inner-stage-${stage}.txt`);
        log(`dry-run: stage=${stage} backend=codex sandbox=${sb} cwd=${cwd}`);
        const codexArgs = buildCodexArgs(stage, '<prompt>', cwd, lm, REPO_ROOT);
        log(`dry-run: codex exec ${codexArgs.join(' ')}`);
      } else {
        log(`dry-run: stage=${stage} backend=claude agent=${agent} permission-mode=${permissionMode} allowedTools=${(allowedTools || []).join(',')} cwd=${cwd}`);
        log(`dry-run: claude -p '<prompt>' --agent ${agent} --output-format json --permission-mode ${permissionMode}`);
      }
      log(`dry-run: prompt preview:\n${promptPreview}\n`);
    }
    log('dry-run: transition plan — PLAN_READY->IMPLEMENT, IMPL_DONE->REVIEW, REVIEW PASS->VERIFY / CHANGES->IMPLEMENT (max 2 cycles), VERIFY GREEN->MERGE / RED->TRIAGE, TRIAGE KNOWN->IMPLEMENT only when implementable / P4 Codex sandbox EPERM->ESCALATE / NOVEL->ESCALATE, missing/unparsable VERDICT->ESCALATE');
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
      if (state === 'REVIEW') {
        log(`rebasing worktree onto main before review (issue #${issueNumber})`);
        if (!rebaseWorktree(worktreePath)) {
          writeEscalation(issueNumber, 'REVIEW', 'REBASE_CONFLICT', 'git rebase main failed in worktree');
          state = 'ESCALATE'; break;
        }
      }
      headSha = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    }

    const prompt = buildStagePrompt(state, {
      issueNumber, issueTitle: issue.title, issueBody: issue.body,
      plan, feedback, headSha, verifyResult,
    });

    const backend = selectBackend(state, backendFlags);
    log(`stage=${state} backend=${backend} cwd=${cwd} — spawning ${backend}`);
    const stageStartedAt = Date.now();
    const envelope = runStage(state, prompt, cwd, null, backend);
    const durationMs = Math.max(1, Date.now() - stageStartedAt);
    const verdict = parseVerdict(envelope.result);

    appendManifestEntry(issueNumber, buildManifestEntry({
      stage: state, sessionId: envelope.session_id ?? null,
      verdict, costUsd: envelope.total_cost_usd ?? null, durationMs, backend: envelope.backend ?? null,
    }));

    if (verdict === null) { writeEscalation(issueNumber, state, null, envelope.result ?? ''); state = 'ESCALATE'; break; }

    if (state === 'PLAN' && verdict === 'PLAN_READY') plan = envelope.result;
    if (state === 'REVIEW' && verdict === 'CHANGES') feedback = envelope.result;
    if (state === 'VERIFY' && verdict === 'RED') verifyResult = envelope.result;
    const nonImplementableKnown =
      state === 'TRIAGE' && verdict === 'KNOWN' && isCodexSandboxEpermTriageResult(envelope.result);
    if (state === 'TRIAGE' && verdict === 'KNOWN' && !nonImplementableKnown) feedback = envelope.result;

    const receipt = buildReceiptArgs(state, headSha, verdict);
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
