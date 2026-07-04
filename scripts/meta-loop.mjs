#!/usr/bin/env node
// CLI: node scripts/meta-loop.mjs --profile <id> [--dry-run] [--serial <n>] [--reason <text>]
// meta-loop driver — SCOPE→GROUND→DIAGNOSE→REPORT read-only state machine.
// ADR 0024 §gap#5. Design: design/outer-loop-family.md §3.1.
//
// MCP note: GROUND needs lathe MCP tools. Headless claude reads .mcp.json at repo root.
// .mcp.json does not exist in this repo (2026-07-04). file:/cmd: grounding still works.
// ADR follow-up needed if full MCP grounding is required. (See design §gap#5 notes.)

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  buildManifestEntry,
  UNPARSABLE_VERDICT, MAX_UNPARSABLE_STAGE_RETRIES,
  tailLines, backendCostSourceForEnvelope,
} from './inner-loop.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Constants ---

export const META_STAGES = ['SCOPE', 'GROUND', 'DIAGNOSE', 'REPORT'];
export const META_VERDICT_TOKENS = ['SCOPED', 'GROUNDED', 'DIAGNOSED', 'REPORTED', 'ESCALATE'];
export const META_OK_VERDICTS = {
  SCOPE: 'SCOPED', GROUND: 'GROUNDED', DIAGNOSE: 'DIAGNOSED', REPORT: 'REPORTED',
};

// --- Pure / testable exports ---

export function parseMetaVerdict(resultText) {
  if (!resultText || typeof resultText !== 'string') return null;
  const matches = [...resultText.matchAll(/VERDICT:\s*([A-Z_]+)/g)];
  if (matches.length === 0) return null;
  const token = matches[matches.length - 1][1];
  return META_VERDICT_TOKENS.includes(token) ? token : null;
}

export function nextMetaState(state, verdict) {
  if (verdict === null) return { next: 'ESCALATE' };
  const okVerdict = META_OK_VERDICTS[state];
  if (!okVerdict) return { next: 'ESCALATE' };
  if (verdict === okVerdict) {
    const idx = META_STAGES.indexOf(state);
    const nextStage = META_STAGES[idx + 1];
    return { next: nextStage ?? 'DONE' };
  }
  return { next: 'ESCALATE' };
}

/**
 * Stage permissions — all meta stages are read-only (no Write/Edit in allowedTools).
 * GROUND additionally includes lathe MCP tools for evidence grounding.
 */
export function metaStagePermissions(stage) {
  const base = ['Read', 'Grep', 'Glob', 'Bash(git *)', 'Bash(node *)'];
  const mcp = [
    'mcp__lathe__list_runs', 'mcp__lathe__get_run', 'mcp__lathe__list_sessions',
    'mcp__lathe__get_session_bundle', 'mcp__lathe__get_session_events',
    'mcp__lathe__get_evidence_context', 'mcp__lathe__query_findings',
  ];
  switch (stage) {
    case 'SCOPE':   return { agent: 'meta-auditor', permissionMode: 'dontAsk', allowedTools: [...base] };
    case 'GROUND':  return { agent: 'meta-auditor', permissionMode: 'dontAsk', allowedTools: [...base, ...mcp] };
    case 'DIAGNOSE': return { agent: 'meta-auditor', permissionMode: 'dontAsk', allowedTools: [...base] };
    case 'REPORT':  return { agent: 'meta-auditor', permissionMode: 'dontAsk', allowedTools: [...base] };
    default: throw new Error(`metaStagePermissions: unknown stage "${stage}"`);
  }
}

export function loadProfile(profileId, { repoRoot = REPO_ROOT } = {}) {
  if (!profileId || typeof profileId !== 'string') return { ok: false, error: 'profileId must be a non-empty string' };
  const p = join(repoRoot, 'scripts', 'meta-profiles', `${profileId}.json`);
  if (!existsSync(p)) return { ok: false, error: `profile not found: ${p}` };
  try { return { ok: true, profile: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, error: `failed to parse profile ${profileId}: ${e.message}` }; }
}

export function buildMetaRunKey(profileId, serial) {
  return `meta-${profileId}-${String(serial).padStart(3, '0')}`;
}

export function nextMetaSerial(profileId, { repoRoot = REPO_ROOT } = {}) {
  const runsDir = join(repoRoot, '.lathe', 'runs');
  if (!existsSync(runsDir)) return 1;
  const prefix = `meta-${profileId}-`;
  const existing = readdirSync(runsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => { const n = parseInt(f.slice(prefix.length, -5), 10); return Number.isFinite(n) ? n : 0; });
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

export function metaManifestPath(profileId, serial, { repoRoot = REPO_ROOT } = {}) {
  return join(repoRoot, '.lathe', 'runs', `${buildMetaRunKey(profileId, serial)}.json`);
}

export function buildMetaManifest(profileId, serial, stages, extra = {}) {
  return { loop_kind: 'meta', profile: profileId, run_key: buildMetaRunKey(profileId, serial), serial, ...extra, stages };
}

export function parseMetaDriverArgs(argv) {
  let profileId = null; let dryRun = false; let serial = null; let reason = 'manual';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { dryRun = true; }
    else if (arg === '--profile') { profileId = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith('--profile=')) { profileId = arg.slice('--profile='.length); }
    else if (arg === '--serial') { serial = parseInt(argv[i + 1] ?? '', 10); i += 1; }
    else if (arg.startsWith('--serial=')) { serial = parseInt(arg.slice('--serial='.length), 10); }
    else if (arg === '--reason') { reason = argv[i + 1] ?? 'manual'; i += 1; }
    else if (arg.startsWith('--reason=')) { reason = arg.slice('--reason='.length); }
    else if (arg.startsWith('--')) { return { profileId, dryRun, serial, reason, error: `unknown argument: ${arg}` }; }
    else { return { profileId, dryRun, serial, reason, error: `unexpected positional argument: ${arg}` }; }
  }
  if (!profileId) return { profileId, dryRun, serial, reason, error: 'missing required --profile <id>' };
  if (serial !== null && (!Number.isInteger(serial) || serial < 1)) {
    return { profileId, dryRun, serial, reason, error: 'invalid --serial: must be a positive integer' };
  }
  return { profileId, dryRun, serial, reason, error: null };
}

// --- Stage prompt builders ---

export function buildScopePrompt(profile, { reason = 'manual' } = {}) {
  return [
    '# meta-loop SCOPE — Read-only. Do NOT write files.',
    `Profile: ${profile.id} | target: ${profile.target}`,
    `Cadence: ${profile.cadence || '(unspecified)'}`,
    '',
    'Questions (pick ONE for this run):',
    ...(profile.questions || []).map((q, i) => `${i + 1}. ${q}`),
    '',
    'Grounding surfaces:', ...(profile.grounding || []).map((g) => `- ${g}`),
    '',
    `Reason: ${reason}`,
    '',
    'Task: Select the single most important question. State audit plan: question + grounding + depth_budget.',
    'Rule: 1 run 1 question. Narrow scope.',
    '',
    'VERDICT: SCOPED    — plan confirmed',
    'VERDICT: ESCALATE  — cannot confirm (invalid profile, no viable question)',
  ].join('\n');
}

export function buildGroundPrompt(profile, scopeResult) {
  return [
    '# meta-loop GROUND — Read-only. Do NOT write files or DB.',
    '',
    '## Audit plan (from SCOPE)', scopeResult,
    '',
    'Grounding surfaces:', ...(profile.grounding || []).map((g) => `- ${g}`),
    `Depth budget: ${profile.depth_budget || 'suspect 上限 5・fan-out 上限 4'}`,
    '',
    '## fan-out contract (ADR 0024 §4)',
    'Pass   → { target, question, grounding: string[], depth_limit: number }',
    'Return ← { problem, evidence_coords, hypothesis, confidence: "high"|"med"|"low" }',
    'Discard deviating results; re-request once. Discard on second failure.',
    '',
    '## X1 — inner loop nesting FORBIDDEN',
    'Do NOT spawn PLAN/IMPLEMENT/REVIEW/VERIFY/TRIAGE/MERGE agents.',
    '',
    'Task: Probe surfaces (triage→backbone→raw). Collect evidence with coordinates (run_key+stage or session_id+seq).',
    '',
    'VERDICT: GROUNDED  — evidence collected',
    'VERDICT: ESCALATE  — evidence unavailable',
  ].join('\n');
}

export function buildDiagnosePrompt(profile, groundResult) {
  return [
    '# meta-loop DIAGNOSE — Read-only. Do NOT write files.',
    '',
    '## Evidence bundle (from GROUND)', groundResult,
    '',
    '## Classification taxonomy (result-classification skill §判別表 — 13 rows)',
    'For each finding record:',
    '  分類=行<N>（変更対象） ／ 根拠座標=<run_key+stage|session_id+seq> ／ なぜこの行か=<1〜2文> ／ 確信度=high|med|low',
    '',
    'Row 3/13 boundary: owner can articulate + evidence in finite tries → Row 3; else → Row 13.',
    'If Row 13 is touched or 3/13 boundary unclear → VERDICT: ESCALATE.',
    '',
    'Task: Apply taxonomy to each evidence item. Do not invent findings. Classify, do not decide.',
    '',
    'VERDICT: DIAGNOSED  — all evidence classified',
    'VERDICT: ESCALATE   — row 13 touched or boundary unclear',
  ].join('\n');
}

export function buildReportPrompt(profile, diagnoseResult, runKey) {
  return [
    '# meta-loop REPORT — Read-only. Do NOT write files (driver writes .lathe/meta/).',
    '',
    '## Classified findings (from DIAGNOSE)', diagnoseResult,
    '',
    `Profile: ${profile.id} | Run key: ${runKey}`,
    '',
    'For each finding write: 種別(keep|improve|fix) / 優先度(high|med|low) / 観点 / 具体策 / 根拠座標 / 分類行',
    'Add 判断記録: なぜこの finding・行の根拠・確信度',
    'Do NOT take ACT-system actions (rubric updates, issue creation, code changes).',
    '',
    'VERDICT: REPORTED',
  ].join('\n');
}

export function buildMetaStagePrompt(stage, context) {
  switch (stage) {
    case 'SCOPE':    return buildScopePrompt(context.profile, { reason: context.reason ?? 'manual' });
    case 'GROUND':   return buildGroundPrompt(context.profile, context.scopeResult ?? '');
    case 'DIAGNOSE': return buildDiagnosePrompt(context.profile, context.groundResult ?? '');
    case 'REPORT':   return buildReportPrompt(context.profile, context.diagnoseResult ?? '', context.runKey ?? '');
    default: throw new Error(`buildMetaStagePrompt: unknown stage "${stage}"`);
  }
}

/**
 * Run one meta stage attempt, recording every attempt, and retry once when the
 * result has no parseable meta VERDICT token. Uses parseMetaVerdict (not inner-loop
 * parseVerdict) so meta tokens SCOPED/GROUNDED/DIAGNOSED/REPORTED are recognised.
 * @param {{ runAttempt: Function, recordAttempt: Function, onRetry?: Function, maxRetries?: number }} p
 * @returns {object & { verdict: string|null, manifestVerdict: string }}
 */
export function runMetaStageWithRetry({
  runAttempt,
  recordAttempt,
  onRetry,
  maxRetries = MAX_UNPARSABLE_STAGE_RETRIES,
} = {}) {
  if (typeof runAttempt !== 'function') throw new TypeError('runAttempt is required');
  if (typeof recordAttempt !== 'function') throw new TypeError('recordAttempt is required');

  let unparsableRetries = 0;
  while (true) { // eslint-disable-line no-constant-condition
    const attempt = runAttempt();
    const envelope = attempt?.envelope ?? {};
    const verdict = parseMetaVerdict(envelope.result);
    const manifestVerdict = verdict ?? UNPARSABLE_VERDICT;
    recordAttempt({ ...attempt, envelope, verdict, manifestVerdict, unparsableRetries });

    if (verdict !== null) return { ...attempt, envelope, verdict, manifestVerdict };
    if (unparsableRetries >= maxRetries) return { ...attempt, envelope, verdict: null, manifestVerdict };

    unparsableRetries += 1;
    onRetry?.({ retriesUsed: unparsableRetries, nextAttempt: unparsableRetries + 1 });
  }
}

// --- Side-effectful helpers ---

function die(msg) { process.stderr.write(`meta-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[meta-loop] ${msg}\n`); }

function readManifestStages(p) {
  if (!existsSync(p)) return [];
  try { const d = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(d.stages) ? d.stages : []; }
  catch { return []; }
}

function appendMetaManifestEntry(profileId, serial, entry) {
  const p = metaManifestPath(profileId, serial);
  mkdirSync(dirname(p), { recursive: true });
  const stages = readManifestStages(p);
  stages.push(entry);
  writeFileSync(p, JSON.stringify(buildMetaManifest(profileId, serial, stages), null, 2) + '\n', 'utf8');
}

function writeMetaReport(runKey, reportText) {
  const dir = join(REPO_ROOT, '.lathe', 'meta', runKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), reportText, 'utf8');
}

function writeMetaEscalation(profileId, serial, stage, verdict, resultExcerpt) {
  const runKey = buildMetaRunKey(profileId, serial);
  const p = join(REPO_ROOT, '.lathe', 'runs', `${runKey}.escalation.md`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, [
    `# escalation — meta-loop ${runKey}`,
    `stage: ${stage}`, `verdict: ${verdict ?? '(none/unparsable)'}`, `ts: ${new Date().toISOString()}`,
    '', '## result excerpt', '```', tailLines(resultExcerpt, 40), '```', '',
  ].join('\n'), 'utf8');
}

function runMetaStageClaude(stage, prompt) {
  const { permissionMode, allowedTools } = metaStagePermissions(stage);
  const args = ['-p', prompt, '--agent', 'meta-auditor', '--output-format', 'json', '--permission-mode', permissionMode];
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  const r = spawnSync('claude', args, {
    encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 1e8,
    env: { ...process.env, LATHE_STAGE: stage },
  });
  if (r.status !== 0 && !r.stdout) die(`claude -p failed for meta stage ${stage}: ${r.stderr || 'no output'}`);
  let env;
  try { env = JSON.parse(r.stdout); }
  catch (e) { die(`could not parse claude envelope for meta stage ${stage}: ${e.message}`); }
  return {
    session_id: env.session_id ?? null, result: env.result ?? '',
    total_cost_usd: env.total_cost_usd ?? null, backend: 'claude',
    backend_cost_source: 'claude.result.total_cost_usd',
  };
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const parsed = parseMetaDriverArgs(process.argv.slice(2));
  if (parsed.error) {
    die(`${parsed.error}\nusage: node scripts/meta-loop.mjs --profile <id> [--dry-run] [--serial <n>] [--reason <text>]`);
  }

  const { profileId, dryRun, reason } = parsed;
  const profileResult = loadProfile(profileId);
  if (!profileResult.ok) die(profileResult.error);
  const { profile } = profileResult;

  const serial = (parsed.serial !== null && parsed.serial !== undefined)
    ? parsed.serial : nextMetaSerial(profileId);
  const runKey = buildMetaRunKey(profileId, serial);

  if (dryRun) {
    log(`dry-run: meta-loop profile=${profileId} serial=${serial} run_key=${runKey} reason=${reason}`);
    log(`dry-run: manifest ${metaManifestPath(profileId, serial)}`);
    log(`dry-run: report dir .lathe/meta/${runKey}/`);
    log('dry-run: MCP note — GROUND needs lathe MCP tools; .mcp.json not found in repo (2026-07-04); file:/cmd: grounding still works');
    for (const stage of META_STAGES) {
      const { permissionMode, allowedTools } = metaStagePermissions(stage);
      const okVerdict = META_OK_VERDICTS[stage];
      log(`dry-run: stage=${stage} backend=claude agent=meta-auditor permission-mode=${permissionMode} allowedTools=${allowedTools.length}`);
      log(`dry-run:   verdict=${okVerdict} -> ${nextMetaState(stage, okVerdict).next} | ESCALATE -> terminal`);
    }
    log('dry-run: transition plan — SCOPE:SCOPED→GROUND, GROUND:GROUNDED→DIAGNOSE, DIAGNOSE:DIAGNOSED→REPORT, REPORT:REPORTED→DONE; any null/ESCALATE→ESCALATE');
    process.exit(0);
  }

  let state = 'SCOPE';
  let scopeResult = ''; let groundResult = ''; let diagnoseResult = '';

  log(`starting meta-loop profile=${profileId} serial=${serial} run_key=${runKey} reason=${reason}`);

  while (state !== 'DONE' && state !== 'ESCALATE') {
    const prompt = buildMetaStagePrompt(state, { profile, reason, scopeResult, groundResult, diagnoseResult, runKey });
    log(`stage=${state} backend=claude — spawning claude`);

    const stageResult = runMetaStageWithRetry({
      runAttempt: () => {
        const t0 = Date.now();
        const envelope = runMetaStageClaude(state, prompt);
        return { envelope, durationMs: Math.max(1, Date.now() - t0) };
      },
      recordAttempt: ({ envelope, manifestVerdict, durationMs }) => {
        appendMetaManifestEntry(profileId, serial, buildManifestEntry({
          stage: state, sessionId: envelope.session_id ?? null, verdict: manifestVerdict,
          backendCostUsd: envelope.total_cost_usd ?? null,
          backendCostSource: backendCostSourceForEnvelope(envelope),
          durationMs, backend: 'claude', resultText: envelope.result ?? '',
        }));
      },
      onRetry: () => log(`stage=${state} verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });

    const { envelope, verdict } = stageResult;

    if (verdict === null) {
      writeMetaEscalation(profileId, serial, state, UNPARSABLE_VERDICT, envelope.result ?? '');
      state = 'ESCALATE'; break;
    }

    if (state === 'SCOPE' && verdict === 'SCOPED') scopeResult = envelope.result ?? '';
    if (state === 'GROUND' && verdict === 'GROUNDED') groundResult = envelope.result ?? '';
    if (state === 'DIAGNOSE' && verdict === 'DIAGNOSED') diagnoseResult = envelope.result ?? '';
    if (state === 'REPORT' && verdict === 'REPORTED') writeMetaReport(runKey, envelope.result ?? '');

    const { next } = nextMetaState(state, verdict);
    if (next === 'ESCALATE') writeMetaEscalation(profileId, serial, state, verdict, envelope.result ?? '');
    log(`stage=${state} verdict=${verdict} -> next=${next}`);
    state = next;
  }

  if (state === 'ESCALATE') die(`meta-loop escalated — see .lathe/runs/${runKey}.escalation.md`);
  log(`done — meta-loop ${runKey} completed. Report: .lathe/meta/${runKey}/report.md`);
  process.exit(0);
}
