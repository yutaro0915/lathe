#!/usr/bin/env node
// CLI: node scripts/review-engine.mjs [--dry-run] [--pr <n>]
// review engine — one-shot review pass over open PRs (ADR 0030 追記 B / issue #128).
//
// Why local: the engine's reason to exist is spawning the reviewer *locally*
// (claude -p) so the transcript lands in ~/.claude/projects and is ingested
// into lathe's observation surface — a gh-hosted review run would be invisible
// to lathe. Review is a record, not a gate (ADR 0028): the result is posted as
// a non-blocking PR comment and never blocks the landing.
//
// One pass (run from cron or by hand; no resident loop): list open PRs →
// derive "awaiting review" — a PR is done when any comment/review already
// carries the `## REVIEW:` heading or this engine's marker. State is derived,
// never stored (ADR 0031). For each target, spawn the reviewer with the PR
// diff + body + linked issue, then post the verdict + findings back as a
// marker-carrying PR comment.
//
// Since the LAND review 前置 (#201 分解 11-12 / #188), the driver reviews its
// own PRs synchronously at LAND (reusing this engine's prompt / spawn / marker
// / verdict-parse functions) and posts the same marker comment — so driver PRs
// arrive here already carrying a review record and are skipped. This engine
// remains the review recorder for PRs not produced by the driver (#201 分類
// 規則 4: 非 driver 産 PR の記録係として不変). The `## REVIEW:` heading
// detection still recognises historical landing-time comments (pre-#116 PRs).
//
// Out of scope (issue #117): CI RED / CHANGES non-convergence pickup and
// escalation. This engine drives reviews only.
//
// Pure logic is exported for unit testing; spawn/gh side effects take a
// deps injection point ({ spawnSync }) like inner-loop.mjs.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function die(msg) { process.stderr.write(`review-engine: error: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[review-engine] ${msg}\n`); }

// --- Constants ---

// Machine marker for comments posted by this engine (detection is content-
// based, not author-based: the engine and the human operator share one
// GitHub account).
export const ENGINE_MARKER = '<!-- lathe-review-engine -->';
// Review-record heading (`## REVIEW: <verdict>`). Written by this engine;
// also matches historical landing-time comments from the pre-#116 driver.
// Either record means "reviewed".
export const REVIEW_HEADING = '## REVIEW:';
// Same tokens as the task-loop REVIEW stage (inner-loop-prompts.mjs).
export const REVIEW_VERDICT_TOKENS = ['PASS', 'CHANGES', 'ESCALATE'];
// Inline-diff budget for the reviewer prompt. Oversized diffs are truncated
// and the reviewer is told to fetch the remainder via `gh pr diff <n>`.
export const DIFF_CHAR_LIMIT = 120_000;
export const MAX_UNPARSABLE_RETRIES = 1;
const PR_LIST_LIMIT = 100;
const PR_JSON_FIELDS = 'number,title,body,isDraft,headRefName,url,comments,reviews';

// Read-only toolset: the REVIEW stage's narrow set (inner-loop-backends.mjs)
// plus read-only gh commands so the reviewer can ground itself in the PR
// (full diff when truncated, linked issues). No blanket Bash, no edits.
export const REVIEWER_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Bash(git *)',
  'Bash(gh pr view *)', 'Bash(gh pr diff *)', 'Bash(gh issue view *)',
];

// --- Pure / testable exports ---

/**
 * Parse CLI flags. Returns { ok: true, dryRun, pr } or { ok: false, error }.
 * @param {string[]} argv  process.argv.slice(2)
 */
export function parseEngineFlags(argv) {
  const flags = { dryRun: false, pr: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { flags.dryRun = true; continue; }
    if (arg === '--pr') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        return { ok: false, error: `--pr requires a positive integer, got: ${argv[i + 1] ?? '(none)'}` };
      }
      flags.pr = value;
      i++;
      continue;
    }
    return { ok: false, error: `unknown flag: ${arg}` };
  }
  return { ok: true, ...flags };
}

/**
 * True when the PR already carries a review record: any issue comment or
 * PR review whose body contains the engine marker or the `## REVIEW:`
 * heading (also written by the pre-#116 driver's landing-time comment).
 * @param {{ comments?: Array<{body?: string}>, reviews?: Array<{body?: string}> }} pr
 * @returns {boolean}
 */
export function hasReviewRecord(pr) {
  const bodies = [...(pr.comments ?? []), ...(pr.reviews ?? [])]
    .map((c) => c?.body ?? '');
  return bodies.some((b) => b.includes(ENGINE_MARKER) || b.includes(REVIEW_HEADING));
}

/**
 * Derive the review targets from the open-PR listing — the "awaiting review"
 * state is computed from PR contents on every pass, never persisted.
 * Draft PRs are skipped: a draft is the author's explicit "not ready for
 * review" signal, and it will be picked up on a later pass once marked ready.
 * @param {Array<object>} prs  gh pr list --json output
 * @param {{ onlyPr?: number|null }} opts
 * @returns {{ targets: object[], skipped: Array<{number: number, reason: string}> }}
 */
export function deriveReviewTargets(prs, { onlyPr = null } = {}) {
  const targets = [];
  const skipped = [];
  for (const pr of prs) {
    if (onlyPr !== null && pr.number !== onlyPr) continue;
    if (pr.isDraft) { skipped.push({ number: pr.number, reason: 'draft' }); continue; }
    if (hasReviewRecord(pr)) { skipped.push({ number: pr.number, reason: 'already reviewed (## REVIEW: record present)' }); continue; }
    targets.push(pr);
  }
  return { targets, skipped };
}

/**
 * Extract GitHub issue references (#N) from text, deduplicated in order.
 * @param {string} text
 * @returns {number[]}
 */
export function extractIssueRefs(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  for (const m of text.matchAll(/#(\d+)/g)) {
    seen.add(Number(m[1]));
  }
  return [...seen];
}

/**
 * Truncate a diff to the inline prompt budget.
 * @param {string} diffText
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateDiff(diffText, limit = DIFF_CHAR_LIMIT) {
  const text = diffText ?? '';
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

// Bare `VERDICT: <TOKEN>` lines are noise when reviewer output is embedded in
// a comment or a follow-up prompt (only the heading / driver parse carries the
// verdict). Shared by formatReviewComment and the rereview 前回所見 injection.
function stripBareVerdictLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^VERDICT:\s*[A-Z_]+\s*$/.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * Reviewer prompt for one PR. Follows the review skill's viewpoints but adapts
 * the diff source: the PR branch is not necessarily checked out locally, so
 * the diff comes inline (from `gh pr diff`), not from `git diff main...HEAD`.
 * No new review criteria are invented here — plan and rubrics stay the source.
 *
 * LAND review 前置 (#201 分解 11-12) extensions, both optional so the engine's
 * standalone pass is unchanged:
 *   - `planText`: the issue's confirmed plan (TASK_PLAN comment) for plan 照合.
 *   - `rereview` (#188 設計要求「再 review の文脈」): 前回所見＋implementer の
 *     対応表明＋前回 head からの差分を注入し、同一指摘の再発と新規を区別可能にする。
 * @param {{ pr: {number: number, title: string, url?: string, headRefName?: string, body?: string},
 *           diffText: string, diffTruncated: boolean,
 *           issue?: {number: number, title?: string, body?: string}|null,
 *           planText?: string|null,
 *           rereview?: { round: number, maxRounds: number, previousFindings?: string|null,
 *                        implementerResponse?: string|null, previousHeadSha?: string|null,
 *                        deltaDiffText?: string|null, deltaDiffTruncated?: boolean }|null }} ctx
 * @returns {string}
 */
export function buildEngineReviewPrompt({ pr, diffText, diffTruncated, issue = null, planText = null, rereview = null }) {
  const lines = [
    `PR #${pr.number} / stage: REVIEW (review engine)`,
    '',
    '`.claude/skills/review/SKILL.md` の観点（設計/plan 遵守・抜け・risk）に従い、下記の PR diff を PR 本文（plan に相当）＋該当 rubric に照らしてレビューしてください。',
    '該当 rubric は `node rubrics/run.mjs --changed <paths>` が選ぶのと同じ scope の rubric 群（`rubrics/`）を読んで判断すること。',
    'この PR の branch はローカルに checkout されていない可能性があります。diff は下記 inline のものを使い、`git diff main...HEAD` は使わないこと。周辺コードの確認は main checkout の Read/Grep で行うこと。',
    'read-only: コード編集・git 変更・merge をしない。指摘＋verdict のみ返すこと。',
    '指摘ごとに severity（blocker / major / minor）/ 位置（file:line）/ 何が / なぜ（どの plan 項目・rubric・設計原則に反するか）を書くこと。major 以上は plan/rubric/明文原則違反に限る。過剰 flag 禁止。',
    '',
    '## PR',
    `- number: #${pr.number}`,
    `- title: ${pr.title ?? ''}`,
    `- branch: ${pr.headRefName ?? ''}`,
    `- url: ${pr.url ?? ''}`,
    '',
    '## PR 本文',
    pr.body?.trim() ? pr.body : '(本文なし)',
  ];
  if (issue) {
    lines.push(
      '',
      `## 関連 issue #${issue.number}`,
      `title: ${issue.title ?? ''}`,
      '',
      issue.body ?? '',
    );
  }
  if (planText) {
    lines.push(
      '',
      '## 確定 plan（issue の plan comment。PR diff はこの plan にも照らして審査すること）',
      '',
      planText,
    );
  }
  lines.push(
    '',
    diffTruncated
      ? `## diff（\`gh pr diff ${pr.number}\` の先頭 ${DIFF_CHAR_LIMIT} chars で截断。全量は \`gh pr diff ${pr.number}\` で取得すること）`
      : `## diff（\`gh pr diff ${pr.number}\`）`,
    '',
    diffText,
  );
  if (rereview) {
    lines.push(
      '',
      `## 再 review 文脈（CHANGES 差し戻し後の修正周回 ${rereview.round}/${rereview.maxRounds}）`,
      '',
      'この PR は前回 review で CHANGES となり、implementer が同一 branch への追い commit（または理由付きの対応表明のみ）で応答済みです。',
      '前回所見と前回 head からの差分を踏まえ、指摘ごとに「解消 / 同一指摘の再発（未解消） / 新規」を区別して書くこと。対応しない理由が表明された指摘は、その理由の妥当性を審査すること。',
      '',
      '### 前回 review 所見',
      '',
      stripBareVerdictLines(rereview.previousFindings) || '(前回所見なし)',
    );
    if (rereview.implementerResponse) {
      lines.push(
        '',
        '### implementer の対応表明（指摘ごとの対応可否）',
        '',
        stripBareVerdictLines(rereview.implementerResponse),
      );
    }
    lines.push(
      '',
      rereview.deltaDiffTruncated
        ? `### 前回 head（${rereview.previousHeadSha ?? '(unknown)'}）からの差分（截断。全量は \`gh pr diff ${pr.number}\` で確認）`
        : `### 前回 head（${rereview.previousHeadSha ?? '(unknown)'}）からの差分`,
      '',
      rereview.deltaDiffText?.trim() ? rereview.deltaDiffText : '(差分なし — implementer は commit を積まず対応表明のみ返しています)',
    );
  }
  lines.push(
    '',
    `最終行に必ず次の形式で verdict を出力してください（他の形式は不可）:\nVERDICT: <TOKEN>\n<TOKEN> は次のいずれか: ${REVIEW_VERDICT_TOKENS.join(' | ')}`,
  );
  return lines.join('\n');
}

/**
 * Parse the review verdict from the reviewer's result text (last
 * `VERDICT: <TOKEN>` wins, same convention as inner-loop.mjs parseVerdict but
 * restricted to this engine's tokens).
 * @param {string} resultText
 * @returns {string | null}
 */
export function parseReviewVerdict(resultText) {
  if (!resultText || typeof resultText !== 'string') return null;
  const matches = [...resultText.matchAll(/VERDICT:\s*([A-Z_]+)/g)];
  if (matches.length === 0) return null;
  const token = matches[matches.length - 1][1];
  return REVIEW_VERDICT_TOKENS.includes(token) ? token : null;
}

/**
 * PR comment body: engine marker + `## REVIEW: <verdict>` heading (shared
 * with the pre-#116 driver's landing comment so one detection predicate covers both)
 * + the reviewer's findings with bare VERDICT lines stripped.
 * @param {{ verdict: string, resultText: string }} p
 * @returns {string}
 */
export function formatReviewComment({ verdict, resultText }) {
  return `${ENGINE_MARKER}\n${REVIEW_HEADING} ${verdict}\n\n${stripBareVerdictLines(resultText)}\n`;
}

/**
 * argv for `claude ...` spawning the reviewer headlessly. Mirrors
 * buildClaudeArgs (inner-loop-backends.mjs) with the engine's read-only
 * toolset. Never --bare / --dangerously-skip-permissions (hooks must fire).
 * @param {string} prompt
 * @returns {string[]}
 */
export function reviewerArgs(prompt) {
  return [
    '-p', prompt,
    '--agent', 'reviewer',
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--allowedTools', REVIEWER_ALLOWED_TOOLS.join(','),
  ];
}

// --- Side-effect helpers (deps-injectable) ---

/** Run gh with JSON output; returns parsed value or null (with a log) on failure. */
function ghJson(args, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('gh', args, { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 1e8 });
  if (r.status !== 0) {
    log(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr ?? '').trim() || 'no output'}`);
    return null;
  }
  try { return JSON.parse(r.stdout); } catch (e) {
    log(`could not parse gh ${args.slice(0, 3).join(' ')} output: ${e.message}`);
    return null;
  }
}

/** List open PRs with the fields the derivation needs. Returns array or null. */
export function listOpenPrs(deps = {}) {
  return ghJson(['pr', 'list', '--state', 'open', '--json', PR_JSON_FIELDS, '--limit', String(PR_LIST_LIMIT)], deps);
}

/** `gh pr diff <n>` — returns the unified diff text or null on failure. */
export function fetchPrDiff(prNumber, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('gh', ['pr', 'diff', String(prNumber)], { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 1e8 });
  if (r.status !== 0) {
    log(`gh pr diff ${prNumber} failed: ${(r.stderr ?? '').trim() || 'no output'}`);
    return null;
  }
  return r.stdout ?? '';
}

/**
 * Fetch the first issue referenced from the PR title/body (non-fatal: a PR
 * without a resolvable issue is still reviewed against its own body + rubrics).
 */
export function fetchLinkedIssue(pr, deps = {}) {
  const refs = extractIssueRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`);
  if (refs.length === 0) return null;
  const issue = ghJson(['issue', 'view', String(refs[0]), '--json', 'number,title,body'], deps);
  return issue ?? null;
}

/**
 * Spawn the reviewer locally (claude backend) — cwd is the repo root so the
 * transcript lands under this project in ~/.claude/projects and is ingested.
 * LATHE_STAGE=REVIEW arms the verdict-guard Stop hook (format enforcement).
 * Returns the normalized envelope or null on spawn/parse failure.
 */
export function runReviewer(prompt, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('claude', reviewerArgs(prompt), {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    maxBuffer: 1e8,
    env: { ...process.env, LATHE_STAGE: 'REVIEW' },
  });
  if (r.status !== 0 && !r.stdout) {
    log(`claude -p failed: ${(r.stderr ?? '').trim() || 'no output'}`);
    return null;
  }
  try {
    const env = JSON.parse(r.stdout);
    return { session_id: env.session_id ?? null, result: env.result ?? '', total_cost_usd: env.total_cost_usd ?? null };
  } catch (e) {
    log(`could not parse claude envelope: ${e.message}`);
    return null;
  }
}

/**
 * Spawn the reviewer with the engine's unparsable-verdict retry convention
 * (one fresh retry, mirroring the driver). Shared by the engine pass
 * (reviewOnePr) and the driver's LAND review 前置 (#201 分解 11 — reviewer
 * spawn・verdict parse の流儀を再利用する単一の実装).
 * @param {string} prompt
 * @param {{ spawnSync?: Function }} deps
 * @param {{ onRetry?: (attempt: number) => void }} hooks
 * @returns {{ envelope: { session_id: string|null, result: string, total_cost_usd: number|null }|null, verdict: string|null }}
 */
export function spawnReviewerWithRetry(prompt, deps = {}, { onRetry } = {}) {
  let envelope = null;
  let verdict = null;
  for (let attempt = 0; attempt <= MAX_UNPARSABLE_RETRIES; attempt++) {
    if (attempt > 0) onRetry?.(attempt);
    envelope = runReviewer(prompt, deps);
    if (envelope === null) return { envelope: null, verdict: null };
    verdict = parseReviewVerdict(envelope.result);
    if (verdict !== null) break;
  }
  return { envelope, verdict };
}

/** Post the review comment (non-fatal — review is a record, not a gate). */
export function postReviewComment(prNumber, body, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('gh', ['pr', 'comment', String(prNumber), '--body-file', '-'], {
    encoding: 'utf8', cwd: REPO_ROOT, input: body,
  });
  if (r.status !== 0) {
    log(`warning: gh pr comment failed for PR #${prNumber} (non-fatal): ${(r.stderr ?? '').trim()}`);
    return false;
  }
  return true;
}

/**
 * Review one PR end to end: diff → linked issue → reviewer spawn (one retry
 * on unparsable verdict, mirroring the driver's convention) → PR comment.
 * @returns {{ ok: boolean, verdict?: string|null, sessionId?: string|null, reason?: string }}
 */
export function reviewOnePr(pr, deps = {}) {
  const diffRaw = fetchPrDiff(pr.number, deps);
  if (diffRaw === null) return { ok: false, reason: 'diff fetch failed' };
  if (!diffRaw.trim()) return { ok: false, reason: 'empty diff' };
  const { text: diffText, truncated: diffTruncated } = truncateDiff(diffRaw);
  const issue = fetchLinkedIssue(pr, deps);
  const prompt = buildEngineReviewPrompt({ pr, diffText, diffTruncated, issue });

  const { envelope, verdict } = spawnReviewerWithRetry(prompt, deps, {
    onRetry: () => log(`PR #${pr.number}: verdict unparsable -> retrying reviewer once`),
  });
  if (envelope === null) return { ok: false, reason: 'reviewer spawn failed' };
  if (verdict === null) {
    return { ok: false, sessionId: envelope.session_id, reason: 'unparsable verdict after retry' };
  }

  const body = formatReviewComment({ verdict, resultText: envelope.result });
  const posted = postReviewComment(pr.number, body, deps);
  return {
    ok: posted,
    verdict,
    sessionId: envelope.session_id,
    reason: posted ? undefined : 'comment post failed',
  };
}

// --- CLI entrypoint ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const flags = parseEngineFlags(process.argv.slice(2));
  if (!flags.ok) {
    die(`${flags.error}\nusage: node scripts/review-engine.mjs [--dry-run] [--pr <n>]`);
  }

  const prs = listOpenPrs();
  if (prs === null) die('could not list open PRs');
  const { targets, skipped } = deriveReviewTargets(prs, { onlyPr: flags.pr });

  log(`open PRs: ${prs.length}, targets: ${targets.length}, skipped: ${skipped.length}${flags.pr ? ` (--pr ${flags.pr})` : ''}`);
  for (const s of skipped) log(`skip PR #${s.number}: ${s.reason}`);
  if (flags.pr && targets.length === 0 && skipped.length === 0) {
    log(`PR #${flags.pr} not found among open PRs — nothing to do`);
  }

  if (flags.dryRun) {
    for (const pr of targets) {
      log(`dry-run: would review PR #${pr.number} "${pr.title}" (${pr.headRefName}) — spawn reviewer (claude, read-only) with gh pr diff ${pr.number} + PR body + linked issue, then post ${REVIEW_HEADING} comment`);
    }
    process.exit(0);
  }

  let failures = 0;
  for (const pr of targets) {
    log(`reviewing PR #${pr.number} "${pr.title}" (${pr.headRefName})`);
    const result = reviewOnePr(pr);
    if (result.ok) {
      log(`PR #${pr.number}: verdict=${result.verdict} session=${result.sessionId ?? 'unknown'} — comment posted`);
    } else {
      failures++;
      log(`PR #${pr.number}: FAILED — ${result.reason}${result.sessionId ? ` (session=${result.sessionId})` : ''}`);
    }
  }
  log(`pass complete: ${targets.length - failures}/${targets.length} reviewed${failures ? `, ${failures} failed` : ''}`);
  process.exitCode = failures > 0 ? 1 : 0;
}
