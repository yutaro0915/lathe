#!/usr/bin/env node
// CLI: node scripts/inner-loop.mjs <issue#> [--resume] [--dry-run] [--backend claude|codex]
//      [--backend-<stage> claude|codex]
// inner loop driver — state machine over GitHub issue = task (ADR 0031).
// Run types (from labels, never body): task loop (no needs-plan):
//   TASK_PLAN -> PLAN_REVIEW -> IMPLEMENT -> LAND (ADR 0035 §1);
//   plan-task (needs-plan): see inner-loop-plan-task.mjs.
// Startability gates (derived, never stored, ADR 0031 §2): open + unblocked.
// Module layout: inner-loop-core.mjs / -prompts.mjs / -backends.mjs /
//   -stage-runner.mjs / -plan-task.mjs / -projects.mjs.
// Re-exports public symbols from split modules (single import surface).
// ADR 0013 (driver) / 0014 (backends) / 0030 (gates) / 0031 / 0035.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { buildStagePrompt } from './inner-loop-prompts.mjs';
import {
  stagePermissions, stageCwd,
  stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt,
  parseCodexSessionId, parseCodexCostUsd, parseCodexCostReport, parseBackendFlags, selectBackend,
  detectMainDirty, resolveResumeBackend,
  detectHollowImplement,
} from './inner-loop-backends.mjs';
import {
  REPO_ROOT,
  TASK_LOOP_STAGES, TASK_LOOP_TERMINAL,
  UNPARSABLE_VERDICT, WORKTREE_DEPS_INSTALL_ARGS,
  MAX_PLAN_REVIEW_RETRIES, NEEDS_REVIEW_LABEL,
  parseDriverArgsWith, selectRunType, nextState,
  runStageWithUnparsableRetry,
  buildManifestEntry, buildManifest, manifestPathFor, backendCostSourceForEnvelope, readManifestStages,
  decideResumeState, tailLines,
  isWorktreeStage, stageRequiresFreshMainRebase,
  parseBlockedBy, issueLabelNames, hasNeedsReviewLabel,
  worktreeNameFor, extractFirstCommitMessage, splitCommitMessage,
  buildPrBodyWithCloses, buildPrCreateArgs, buildPrMergeArgs,
} from './inner-loop-core.mjs';
import { projectEscalation } from './inner-loop-escalation.mjs';
import { runStage, logDryRunStage } from './inner-loop-stage-runner.mjs';
import { runPlanTask, dryRunPlanTask, readPlanFormatOrDie } from './inner-loop-plan-task.mjs';
import {
  trySetProjectStatus, PROJECTS_STATUS_NAMES,
} from './inner-loop-projects.mjs';

// Re-export the split modules' public symbols so tests / meta-loop.mjs /
// inner-queue.mjs keep importing from this file.
export * from './inner-loop-core.mjs';
export * from './inner-loop-escalation.mjs';
export {
  parseBlockedByLine, parsePlanChildBlocks, resolvePlanChildDependency,
  buildChildIssueBody, parseCreatedIssueNumber, createChildIssues,
  buildPlanTaskCloseComment, buildAskPdmComment, runPlanTask, dryRunPlanTask,
} from './inner-loop-plan-task.mjs';
export { runStage } from './inner-loop-stage-runner.mjs';
export {
  stagePermissions, stageCwd,
  stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt,
  parseCodexSessionId, parseCodexCostUsd, parseCodexCostReport, parseBackendFlags, selectBackend,
  detectMainDirty,
};

/**
 * Parse driver flags (see inner-loop-core.mjs parseDriverArgsWith).
 * @param {string[]} argv
 */
export function parseDriverArgs(argv) {
  return parseDriverArgsWith(argv, parseBackendFlags);
}

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

// Fetch the task (= the GitHub issue, ADR 0031): body = plan, comments =
// 裁定・申し送り, labels = run-type selection, state = open guard.
function fetchIssue(issueNumber) {
  const r = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,state,comments'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) die(`gh issue view failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout); } catch (e) { die(`could not parse gh issue view output: ${e.message}`); }
}

// Resolve blocked-by refs (ADR 0031 §2): a referenced issue that is still
// open blocks the run — the driver refuses to start (着手拒否).
function openBlockers(issueBody) {
  const refs = parseBlockedBy(issueBody);
  const open = [];
  for (const ref of refs) {
    const r = spawnSync('gh', ['issue', 'view', String(ref), '--json', 'state'], { encoding: 'utf8', cwd: REPO_ROOT });
    if (r.status !== 0) die(`gh issue view failed for blocked-by #${ref}: ${r.stderr || r.stdout}`);
    let state;
    try { state = JSON.parse(r.stdout)?.state; } catch (e) { die(`could not parse gh issue view output for blocked-by #${ref}: ${e.message}`); }
    if (String(state).toUpperCase() === 'OPEN') open.push(ref);
  }
  return open;
}

// Startability gates, derived on every run (ADR 0031): open state and
// blocked-by resolution.
function assertStartableOrDie(issueNumber, issue) {
  if (String(issue.state ?? '').toUpperCase() !== 'OPEN') {
    die(`issue #${issueNumber} is not open (state: ${issue.state ?? '(unknown)'}) — nothing to run`);
  }
  const blockers = openBlockers(issue.body);
  if (blockers.length > 0) {
    die(`issue #${issueNumber} is blocked by open issue(s) ${blockers.map((n) => `#${n}`).join(', ')} — refusing to start (ADR 0031 blocked-by)`);
  }
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
  return { branch, path: join(REPO_ROOT, '.claude', 'worktrees', dirName) };
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
  const p = manifestPathFor({ kind: 'issue', id: issueNumber });
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

function worktreeHeadShaOrDie(worktreePath, stage) {
  const head = gitStdout(['-C', worktreePath, 'rev-parse', 'HEAD'], REPO_ROOT);
  if (!head) die(`could not determine worktree HEAD after stage ${stage}`);
  return head;
}

function appendManifestEntry(issueNumber, entry) {
  const unit = { kind: 'issue', id: issueNumber };
  const p = manifestPathFor(unit);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildManifest(unit, stages), null, 2) + '\n', 'utf8');
}

// escalation の issue 化 (#201 分解 6): 対象 issue に escalation label ＋
// レポート全文 comment を投影する（.escalation.md は廃止・非致命）。
function escalateIssue(issueNumber, stage, verdict, resultExcerpt) {
  projectEscalation({ issueNumber, stage, verdict, resultExcerpt }, { log });
}

export function rebaseWorktree(wt, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const result = run('git', ['-C', wt, 'rebase', 'main'], { stdio: 'inherit' });
  if (result.status === 0) return true;

  run('git', ['-C', wt, 'rebase', '--abort'], { stdio: 'inherit' });
  return false;
}

function cleanupWorktree(wt, branch) {
  spawnSync('git', ['worktree', 'remove', wt, '--force'], { cwd: REPO_ROOT, stdio: 'inherit' });
  spawnSync('git', ['branch', '-D', branch], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// --- Landing (ADR 0030 §3: merge.mjs dismantled in #115 — the driver runs
// the three landing steps directly. #116: the local run ends at PR creation;
// the PR body carries `Closes #N` so merge closes the issue = Done, ADR 0031.) ---

// Land `branch` onto main: push → gh pr create → gh pr merge --auto --squash
// (ADR 0026 §1-2 / ADR 0030 §3). The first commit's message becomes the PR
// title/body (with `Closes #<issue>` appended). The actual squash happens on
// GitHub after the CI gate (required check) goes green; review is recorded
// asynchronously on the PR by the review engine (#128).
export function landBranch(branch, issueNumber, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const outputs = [];
  const step = (cmd, args) => {
    const r = run(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    outputs.push(r.stdout ?? '', r.stderr ?? '');
    return r.status === 0;
  };
  const fail = (msg) => {
    outputs.push(`${msg}\n`);
    return { ok: false, output: outputs.join('') };
  };

  // --format=%B%x00: NUL-separated so multi-paragraph bodies / trailers don't
  // collide with the inter-commit separator.
  const logR = run('git', ['log', '--reverse', '--format=%B%x00', `main..${branch}`], { encoding: 'utf8', cwd: REPO_ROOT });
  if (logR.status !== 0) return fail(`could not read commit messages for ${branch}: ${logR.stderr ?? ''}`);
  const { subject, body } = splitCommitMessage(extractFirstCommitMessage(logR.stdout ?? ''));
  if (!subject) return fail(`no commits found between main and ${branch} — nothing to land`);
  const prBody = buildPrBodyWithCloses(body, issueNumber);

  if (!step('git', ['push', '-u', 'origin', branch])) {
    return fail(`git push failed — cannot create PR for ${branch}`);
  }
  if (!step('gh', buildPrCreateArgs({ base: 'main', head: branch, title: subject, body: prBody }))) {
    return fail(`gh pr create failed for ${branch}`);
  }
  if (!step('gh', buildPrMergeArgs({ branch }))) {
    return fail(`gh pr merge --auto failed for ${branch}`);
  }
  return { ok: true, output: outputs.join('') };
}

// --- Dry-run (task loop) ---

function dryRunTaskLoop(issueNumber, issue, backendFlags) {
  const planFormat = readPlanFormatOrDie();
  log(`dry-run: task loop issue #${issueNumber} | manifest ${manifestPathFor({ kind: 'issue', id: issueNumber })}`);
  const refs = parseBlockedBy(issue.body);
  log(refs.length === 0 ? 'dry-run: blocked-by — none' : `dry-run: blocked-by — ${refs.map((n) => `#${n}`).join(', ')}`);
  const { branch: wtBranch, dirName: wtDirName } = worktreeNameFor(issueNumber);
  const wtPath = join(REPO_ROOT, '.claude', 'worktrees', wtDirName);
  log(`dry-run: stages — ${TASK_LOOP_STAGES.join(' -> ')} -> ${TASK_LOOP_TERMINAL}`);
  log(hasNeedsReviewLabel(issue)
    ? `dry-run: needs-review=YES — queue skips unless Projects Status=Ready (ADR 0035 §1)`
    : `dry-run: needs-review=NO — zero human gate (ADR 0035 §1)`);
  log(`dry-run: PLAN_REVIEW RED → retry TASK_PLAN max=${MAX_PLAN_REVIEW_RETRIES}; exhausted → needs-review+escalation labels, stop (ADR 0035 §5)`);
  log(`dry-run: Projects: In progress on start / In review at PR creation (non-fatal); plan-format ${planFormat.length} chars injected into TASK_PLAN fail-closed`);
  log(`dry-run: worktree ${wtPath} on ${wtBranch}; pnpm install failure → P3 fallback`);
  for (const stage of TASK_LOOP_STAGES) {
    const cwd = stageCwd(stage, REPO_ROOT, wtPath);
    const ctx = { issueNumber, issueTitle: issue.title, issueBody: issue.body, comments: issue.comments };
    if (stage === 'TASK_PLAN') ctx.planFormat = planFormat;
    if (stage === 'PLAN_REVIEW') ctx.planText = '(TASK_PLAN result)';
    logDryRunStage(stage, backendFlags, cwd, buildStagePrompt(stage, ctx));
  }
  log(`dry-run: LAND — push → gh pr create (Closes #${issueNumber}) → gh pr merge --auto --squash`);
  log('dry-run: TASK_PLAN PLAN_READY->PLAN_REVIEW, PLAN_REVIEW PASS->IMPLEMENT, IMPL_DONE->LAND, RED->retry, unparsable->retry once then ESCALATE');
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const parsedArgs = parseDriverArgs(process.argv.slice(2));
  const { issueNumber, dryRun, resume, backendFlags } = parsedArgs;

  if (parsedArgs.error) {
    die(`${parsedArgs.error}\nusage: node scripts/inner-loop.mjs <issue#> [--resume] [--dry-run] [--backend claude|codex] [--backend-<stage> claude|codex]`);
  }

  if (dryRun && !resume) {
    log(`dry-run: fetching issue #${issueNumber} via gh issue view`);
    const issue = fetchIssue(issueNumber);
    if (selectRunType(issueLabelNames(issue)) === 'plan-task') {
      dryRunPlanTask(issueNumber, issue, backendFlags);
    } else {
      dryRunTaskLoop(issueNumber, issue, backendFlags);
    }
    process.exit(0);
  }

  if (dryRun && resume) {
    const resumeState = resolveResumeState(issueNumber);
    if (!resumeState.ok) dieResumeUnavailable(issueNumber, resumeState.reason);
    log(`dry-run: resume issue #${issueNumber} from ${manifestPathFor({ kind: 'issue', id: issueNumber })}`);
    log(`dry-run: skipped=${resumeState.skipped.length ? resumeState.skipped.join(',') : '(none)'} next=${resumeState.state} head=${resumeState.headSha ?? '(none)'}`);
    if (resumeState.state === TASK_LOOP_TERMINAL) {
      log(`dry-run: ${TASK_LOOP_TERMINAL} — land ${resumeState.branch}: push → gh pr create (body includes Closes #${issueNumber}) → gh pr merge --auto --squash (from repo root)`);
      process.exit(0);
    }
    const backend = selectBackend(resumeState.state, backendFlags);
    const cwd = stageCwd(resumeState.state, REPO_ROOT, resumeState.worktreePath);
    const promptPreview = buildStagePrompt(resumeState.state, {
      issueNumber, issueTitle: '<title>', issueBody: '<body>', comments: [],
      // resume can restart at TASK_PLAN (#192 Major#1) — inject fail-closed.
      ...(resumeState.state === 'TASK_PLAN' && { planFormat: readPlanFormatOrDie() }),
    });
    log(`dry-run: stage=${resumeState.state} backend=${backend} cwd=${cwd}`);
    log(`dry-run: prompt preview:\n${promptPreview}\n`);
    process.exit(0);
  }

  let worktreePath;
  let branch;
  let state;
  let issue = null;

  if (resume) {
    const resumeState = resolveResumeState(issueNumber);
    if (!resumeState.ok) dieResumeUnavailable(issueNumber, resumeState.reason);
    ({ worktreePath, branch, state } = resumeState);
    log(`resume: skipped=${resumeState.skipped.length ? resumeState.skipped.join(',') : '(none)'} next=${state} head=${resumeState.headSha ?? '(none)'}`);
    if (state !== TASK_LOOP_TERMINAL) issue = fetchIssue(issueNumber);
  } else {
    issue = fetchIssue(issueNumber);
    assertStartableOrDie(issueNumber, issue);

    if (selectRunType(issueLabelNames(issue)) === 'plan-task') {
      const exitCode = runPlanTask(issueNumber, issue, backendFlags);
      process.exit(exitCode ?? 0);
    }

    const wt = prepareWorktree(issueNumber);
    worktreePath = wt.path;
    branch = wt.branch;
    state = TASK_LOOP_STAGES[0];
  }

  let planText = '';
  let planReviewRetries = 0;
  let planReviewFeedback = ''; // 前回 PLAN_REVIEW RED の所見 (#192 Major#2)
  trySetProjectStatus(issueNumber, PROJECTS_STATUS_NAMES.InProgress, { log });

  while (state !== TASK_LOOP_TERMINAL && state !== 'ESCALATE') {
    const cwd = stageCwd(state, REPO_ROOT, worktreePath);

    if (stageRequiresFreshMainRebase(state)) {
      log(`rebasing worktree onto main before ${state} (issue #${issueNumber})`);
      if (!rebaseWorktree(worktreePath)) {
        escalateIssue(issueNumber, state, 'REBASE_CONFLICT', `git rebase main failed in worktree before ${state}`);
        state = 'ESCALATE'; break;
      }
    }

    const implementBaseSha = state === 'IMPLEMENT'
      ? (spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null)
      : null;

    const stageCtx = { issueNumber, issueTitle: issue.title, issueBody: issue.body, comments: issue.comments,
      ...(state === 'TASK_PLAN' && { planFormat: readPlanFormatOrDie(), reviewFeedback: planReviewFeedback }), ...(state === 'PLAN_REVIEW' && { planText }) };
    const prompt = buildStagePrompt(state, stageCtx);

    const fallback = resume
      ? (resolveResumeBackend(readManifestStages(manifestPathFor({ kind: 'issue', id: issueNumber }))) ?? 'claude')
      : 'claude';
    const backend = selectBackend(state, backendFlags, fallback);
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

    if (verdict === null) { escalateIssue(issueNumber, state, UNPARSABLE_VERDICT, envelope.result ?? ''); state = 'ESCALATE'; break; }

    if (state === 'TASK_PLAN' && verdict === 'PLAN_READY') { // capture + post plan comment (ADR 0035 §1)
      planText = envelope.result ?? '';
      if (spawnSync('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'], { cwd: REPO_ROOT, encoding: 'utf8', input: `## plan\n\n${planText}`, stdio: ['pipe', 'pipe', 'pipe'] }).status !== 0) log(`warning: plan comment failed for #${issueNumber}`);
    }
    if (state === 'PLAN_REVIEW' && verdict === 'RED') { // retry TASK_PLAN with 所見注入 (#192 Major#2) or label+stop (ADR 0035 §5)
      planReviewFeedback = envelope.result ?? '';
      if (++planReviewRetries <= MAX_PLAN_REVIEW_RETRIES) { log(`PLAN_REVIEW RED → retry TASK_PLAN (${planReviewRetries}/${MAX_PLAN_REVIEW_RETRIES})`); state = 'TASK_PLAN'; continue; }
      spawnSync('gh', ['issue', 'edit', String(issueNumber), '--add-label', NEEDS_REVIEW_LABEL], { cwd: REPO_ROOT, stdio: 'inherit' }); // escalation label は escalateIssue が付与
      escalateIssue(issueNumber, 'PLAN_REVIEW', 'RED', `RED after ${MAX_PLAN_REVIEW_RETRIES} retries.\n\n${envelope.result ?? ''}`);
      state = 'ESCALATE'; break;
    }

    if (detectHollowImplement({ verdict, baseSha: implementBaseSha, headSha: stageHeadSha })) {
      escalateIssue(issueNumber, 'IMPLEMENT', verdict, 'hollow completion: zero new commits');
      state = 'ESCALATE'; break;
    }

    const { next } = nextState(state, verdict);
    if (next === 'ESCALATE') escalateIssue(issueNumber, state, verdict, envelope.result ?? '');
    log(`stage=${state} verdict=${verdict} -> next=${next}`);
    state = next;
  }

  if (state === 'ESCALATE') die(`escalated — see the escalation label + report comment on issue #${issueNumber}`);

  // Backstop: verify that main working tree has no unexpected tracked changes
  // before landing the branch. The codex workspace-write sandbox should have
  // confined writes to the worktree, but we do NOT rely solely on sandbox
  // enforcement (issue #39, ADR 0014 §3). Only tracked changes are checked;
  // untracked files (??) are ignored to avoid false positives from artefacts.
  log(`backstop: checking main working tree for unexpected tracked changes before landing...`);
  const mainStatusR = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  const { dirty: mainDirty, paths: dirtyPaths } = detectMainDirty(mainStatusR.stdout ?? '');
  if (mainDirty) {
    const excerpt = `main working tree has ${dirtyPaths.length} unexpected tracked change(s) — sandbox write-isolation may have been breached:\n${dirtyPaths.join('\n')}`;
    escalateIssue(issueNumber, TASK_LOOP_TERMINAL, 'MAIN_DIRTY_BACKSTOP', excerpt);
    die(`escalated — main has ${dirtyPaths.length} unexpected tracked change(s) before landing. See the report comment on issue #${issueNumber}`);
  }
  log(`backstop: main working tree clean — proceeding with landing.`);

  log(`landing branch ${branch}: push → gh pr create (Closes #${issueNumber}) → gh pr merge --auto --squash`);
  trySetProjectStatus(issueNumber, PROJECTS_STATUS_NAMES.InReview, { log });
  const landResult = landBranch(branch, issueNumber);
  if (!landResult.ok) {
    escalateIssue(issueNumber, TASK_LOOP_TERMINAL, null, `landing failed\n\n${tailLines(landResult.output)}`);
    die(`landing failed — see the escalation report comment on issue #${issueNumber}`);
  }

  cleanupWorktree(worktreePath, branch);
  log(`done — PR created for issue #${issueNumber} (Closes #${issueNumber}), auto-merge (squash) armed. CI gate completes the landing; the review engine records the review on the PR.`);
  process.exit(0);
}
