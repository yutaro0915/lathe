// inner-loop-stage-runner.mjs — backend adapters that spawn one headless
// agent stage (ADR 0014). Split from inner-loop.mjs at the #116 task-loop
// shrink to keep every module under the 500-line file-size guard. Shared by
// the task-loop driver (inner-loop.mjs) and the plan-task runner
// (inner-loop-plan-task.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  stagePermissions, stageSandbox, buildCodexArgs, buildClaudeArgs,
  stripFrontmatter, buildCodexPrompt, parseCodexSessionId, parseCodexCostReport,
  selectBackend, INNER_SETTINGS_PATH,
} from './inner-loop-backends.mjs';
import { REPO_ROOT } from './inner-loop-core.mjs';

function die(msg) { process.stderr.write(`inner-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[inner-loop] ${msg}\n`); }

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

/** Shared dry-run stage logger (backend / permissions / prompt preview). */
export function logDryRunStage(stage, backendFlags, cwd, promptPreview) {
  const backend = selectBackend(stage, backendFlags);
  if (backend === 'codex') {
    const sb = stageSandbox(stage);
    const lm = join(tmpdir(), `lathe-inner-stage-${stage}.txt`);
    log(`dry-run: stage=${stage} backend=codex sandbox=${sb} cwd=${cwd}`);
    const codexArgs = buildCodexArgs(stage, '<prompt>', cwd, lm, REPO_ROOT);
    log(`dry-run: codex exec ${codexArgs.join(' ')}`);
  } else {
    const { agent, permissionMode, allowedTools } = stagePermissions(stage);
    log(`dry-run: stage=${stage} backend=claude agent=${agent} permission-mode=${permissionMode} allowedTools=${(allowedTools || []).join(',')} cwd=${cwd}`);
    log(`dry-run: claude -p '<prompt>' --agent ${agent} --output-format json --permission-mode ${permissionMode} --settings ${INNER_SETTINGS_PATH}`);
  }
  log(`dry-run: prompt preview:\n${promptPreview}\n`);
}
