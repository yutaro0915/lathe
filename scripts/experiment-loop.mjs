#!/usr/bin/env node
// experiment-loop.mjs — rubric/skill 改訂の比較実験ドライバ
// ADR 0030 §6 + 追記 D。design/loops.md の「実験 loop」行の実体。
//
// 使い方:
//   node scripts/experiment-loop.mjs --experiment <path-to-experiment.json> [--dry-run]
//
// 終端: 採否判断の記録（.lathe/experiments/<id>.json）。採用時の改訂 landing は別途 PR+CI 経由。
//
// experiment.json の形式:
//   id                   実験を一意に識別する文字列
//   title                人間可読なタイトル
//   rubric_id            rubrics/ からの相対 id（node rubrics/run.mjs <rubric_id> に渡す）
//   baseline_rubric_path 現行（baseline）の rubric.json へのリポジトリ相対パス
//   candidate_rubric_path 改訂案の rubric.json へのリポジトリ相対パス
//   revision_description 改訂内容の人間可読な説明
//   predictions          [ { label, baseline, candidate, rationale } ]
//                          baseline/candidate は "PASS" または "RED"
//   declared_by          起票者の表記（issue 番号など）
//   declared_at          宣言日 YYYY-MM-DD

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- pure helpers (testable exports) ---

export function parseExpArgs(argv) {
  let experimentPath = null; let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { dryRun = true; }
    else if (a === '--experiment') { experimentPath = argv[i + 1] ?? null; i += 1; }
    else if (a.startsWith('--experiment=')) { experimentPath = a.slice('--experiment='.length); }
    else if (a.startsWith('--')) { return { experimentPath, dryRun, error: `unknown argument: ${a}` }; }
    else { return { experimentPath, dryRun, error: `unexpected positional argument: ${a}` }; }
  }
  if (!experimentPath) return { experimentPath, dryRun, error: 'missing required --experiment <path>' };
  return { experimentPath, dryRun, error: null };
}

export function loadExperiment(path) {
  if (!existsSync(path)) return { ok: false, error: `experiment file not found: ${path}` };
  try {
    const exp = JSON.parse(readFileSync(path, 'utf8'));
    const required = ['id', 'title', 'rubric_id', 'baseline_rubric_path', 'candidate_rubric_path', 'predictions'];
    for (const k of required) {
      if (exp[k] == null) return { ok: false, error: `experiment.json: missing required field "${k}"` };
    }
    if (!Array.isArray(exp.predictions) || exp.predictions.length === 0) {
      return { ok: false, error: 'experiment.json: predictions must be a non-empty array' };
    }
    for (const p of exp.predictions) {
      if (!['PASS', 'RED'].includes(p.baseline)) return { ok: false, error: `prediction "${p.label}": baseline must be "PASS" or "RED"` };
      if (!['PASS', 'RED'].includes(p.candidate)) return { ok: false, error: `prediction "${p.label}": candidate must be "PASS" or "RED"` };
    }
    return { ok: true, exp };
  } catch (e) {
    return { ok: false, error: `failed to parse experiment.json: ${e.message}` };
  }
}

export function runOutcomeFromExit(exitCode) {
  return exitCode === 0 ? 'PASS' : 'RED';
}

export function evaluatePredictions(predictions, baselineOutcome, candidateOutcome) {
  const comparisons = predictions.map((p) => ({
    label: p.label,
    predicted_baseline: p.baseline,
    observed_baseline: baselineOutcome,
    predicted_candidate: p.candidate,
    observed_candidate: candidateOutcome,
    baseline_matched: p.baseline === baselineOutcome,
    candidate_matched: p.candidate === candidateOutcome,
    matched: p.baseline === baselineOutcome && p.candidate === candidateOutcome,
    rationale: p.rationale ?? null,
  }));
  const allMatched = comparisons.every((c) => c.matched);
  const verdict = allMatched ? 'ADOPT' : 'REJECT';
  const verdict_rationale = allMatched
    ? '全予想が観測と一致した。改訂は意図どおりの効果を持つ（ゲート経由での landing に進める）。'
    : `予想と観測が一致しない項目あり（${comparisons.filter((c) => !c.matched).map((c) => c.label).join(', ')}）。改訂を再設計するか差し戻す。`;
  return { comparisons, verdict, verdict_rationale };
}

export function buildRecord({ exp, baselineRun, candidateRun, evaluation, runAt }) {
  return {
    experiment_id: exp.id,
    run_at: runAt,
    rubric_id: exp.rubric_id,
    revision_description: exp.revision_description ?? null,
    declared_by: exp.declared_by ?? null,
    declared_at: exp.declared_at ?? null,
    baseline: {
      verdict: baselineRun.outcome,
      exit_code: baselineRun.exitCode,
      output_tail: baselineRun.outputTail,
    },
    candidate: {
      verdict: candidateRun.outcome,
      exit_code: candidateRun.exitCode,
      output_tail: candidateRun.outputTail,
    },
    comparison: evaluation.comparisons,
    verdict: evaluation.verdict,
    verdict_rationale: evaluation.verdict_rationale,
    note: evaluation.verdict === 'ADOPT'
      ? '採用の場合、改訂の main への着地は rubric 管理 loop 側で PR 化し PR+CI（出口ゲート）を経ること（ADR 0030 §0）。'
      : '不採用。rubric 管理 loop に差し戻し、改訂案を再設計する。',
  };
}

export function experimentResultPath(expId, { repoRoot = REPO_ROOT } = {}) {
  return join(repoRoot, '.lathe', 'experiments', `${expId}.json`);
}

// --- side-effectful ---

function die(msg) { process.stderr.write(`experiment-loop: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[exp-loop] ${msg}\n`); }

function runRubricGate(rubricId, { repoRoot = REPO_ROOT } = {}) {
  const r = spawnSync('node', ['rubrics/run.mjs', rubricId], {
    encoding: 'utf8', cwd: repoRoot, maxBuffer: 1e7,
  });
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  const exitCode = r.status ?? 1;
  const lines = output.split('\n').filter(Boolean);
  const outputTail = lines.slice(-5).join('\n');
  return { exitCode, output, outputTail, outcome: runOutcomeFromExit(exitCode) };
}

function swapRubric(targetPath, newContent) {
  const original = readFileSync(targetPath, 'utf8');
  writeFileSync(targetPath, newContent, 'utf8');
  return original;
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const parsed = parseExpArgs(process.argv.slice(2));
  if (parsed.error) {
    die(`${parsed.error}\nusage: node scripts/experiment-loop.mjs --experiment <path> [--dry-run]`);
  }

  const expPath = resolve(parsed.experimentPath);
  const result = loadExperiment(expPath);
  if (!result.ok) die(result.error);
  const { exp } = result;

  const baselineRubricPath = join(REPO_ROOT, exp.baseline_rubric_path);
  const candidateRubricPath = join(REPO_ROOT, exp.candidate_rubric_path);

  if (!existsSync(baselineRubricPath)) die(`baseline rubric not found: ${baselineRubricPath}`);
  if (!existsSync(candidateRubricPath)) die(`candidate rubric not found: ${candidateRubricPath}`);

  log(`experiment: ${exp.id}`);
  log(`title: ${exp.title}`);
  log(`rubric_id: ${exp.rubric_id}`);
  log(`predictions: ${exp.predictions.length} item(s)`);

  if (parsed.dryRun) {
    log('dry-run: would run baseline gate → swap rubric → candidate gate → evaluate → record');
    log(`dry-run: baseline rubric: ${baselineRubricPath}`);
    log(`dry-run: candidate rubric: ${candidateRubricPath}`);
    log(`dry-run: record path: ${experimentResultPath(exp.id)}`);
    for (const p of exp.predictions) {
      log(`dry-run: prediction "${p.label}": baseline=${p.baseline} candidate=${p.candidate}`);
    }
    process.exit(0);
  }

  // BASELINE: run gate with current rubric
  log('BASELINE: running gate...');
  const baselineRun = runRubricGate(exp.rubric_id);
  log(`BASELINE: outcome=${baselineRun.outcome} exit=${baselineRun.exitCode}`);

  // CANDIDATE: swap rubric, run gate, restore
  log('CANDIDATE: swapping rubric to candidate...');
  const candidateContent = readFileSync(candidateRubricPath, 'utf8');
  let originalContent = null;
  try {
    originalContent = swapRubric(baselineRubricPath, candidateContent);
    log('CANDIDATE: running gate...');
    var candidateRun = runRubricGate(exp.rubric_id); // eslint-disable-line no-var
    log(`CANDIDATE: outcome=${candidateRun.outcome} exit=${candidateRun.exitCode}`);
  } finally {
    if (originalContent !== null) {
      writeFileSync(baselineRubricPath, originalContent, 'utf8');
      log('CANDIDATE: rubric restored to baseline');
    }
  }

  // EVALUATE: compare predictions to observations
  log('EVALUATE: comparing predictions...');
  const evaluation = evaluatePredictions(exp.predictions, baselineRun.outcome, candidateRun.outcome);
  log(`EVALUATE: verdict=${evaluation.verdict}`);
  for (const c of evaluation.comparisons) {
    const status = c.matched ? 'OK' : 'MISMATCH';
    log(`  [${status}] "${c.label}": baseline predicted=${c.predicted_baseline} observed=${c.observed_baseline} | candidate predicted=${c.predicted_candidate} observed=${c.observed_candidate}`);
  }

  // RECORD: write verdict to .lathe/experiments/
  const runAt = new Date().toISOString();
  const record = buildRecord({ exp, baselineRun, candidateRun, evaluation, runAt });
  const recordPath = experimentResultPath(exp.id);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  log(`RECORD: verdict=${evaluation.verdict} → ${recordPath}`);
  log(`RECORD: ${evaluation.verdict_rationale}`);

  process.exit(0);
}
