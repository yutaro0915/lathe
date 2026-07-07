// inner-loop-land.mjs — LAND 段の review 前置 (#201 分解 11-12; 設計正本は
// issue #201 分類規則 3 と #188「LAND に review 前置」).
// 旧 LAND（push → gh pr create → 無条件で auto-merge arm）を再構成する:
//   push → gh pr create（arm しない）→ reviewer spawn（PR diff＋plan 照合・
//   marker 付き PR コメント投稿）→ verdict 分岐:
//     PASS    → gh pr merge --auto --squash（ここで初めて arm）
//     CHANGES → 所見を IMPLEMENT へ差し戻し（同一 worktree 追い commit → push で
//               PR 自動更新 → 再 review）。修正周回上限 MAX_LAND_REVIEW_REWORK_ROUNDS。
//     超過・不正 verdict → 失敗を返し、driver が projectEscalation で issue へ投影。
// reviewer の spawn・marker・verdict parse は review-engine.mjs の関数を再利用する
// （重複実装しない）。engine 自体は非 driver 産 PR の記録係として不変（分類規則 4）。
//
// #188 の設計要求 5 項への対応（実装上の判断を明文化）:
//   1. 所見の運搬経路 — reviewer の envelope をプロセス内で保持して IMPLEMENT へ
//      直接注入する（採用）。PR コメントは記録（可追跡性）であって運搬経路ではない。
//      比較不採用: PR コメント再取得は、投稿失敗＝運搬失敗という結合を生み、投稿→
//      再取得の round-trip を増やすだけで情報が増えない。ゆえにコメント投稿失敗は
//      warn のみで周回を止めない。
//   2. 注入形式 — buildReviewFeedbackSection（所見注入の単一の口、#192 Major#2 で
//      新設）経由で注入し、指摘ごとの対応可否を implementer に出力させる（握り潰し
//      禁止）。全指摘を理由付きで却下する zero-commit rework も適法で、その対応表明を
//      再 review が裁く（push は commit が進んだ時だけ行う）。
//   3. 再 review の文脈 — 前回所見＋implementer の対応表明＋前回 head からの差分を
//      buildEngineReviewPrompt の rereview セクションとして注入し、同一指摘の再発と
//      新規指摘を区別可能にする。
//   4. 同一 worktree 追い commit・PR は push 更新 — rework は元 IMPLEMENT と同じ
//      worktree で走り、driver が同じ branch を fast-forward push する（force-push
//      禁止）。既存 open PR があれば再利用し、新 PR を作らない（resume にも安全）。
//   5. escalation 時の全周回所見の可追跡性 — 各周回の所見は毎回 marker 付き PR
//      コメントとして投稿されるので、escalation レポートは PR を指すだけで全周回が
//      PR コメント列として追跡できる。
//
// 純関数（verdict 分岐・周回判定ほか）はここで export して unit test する（#188）。
// inner-loop-core.mjs には置けない（500 行 guard）— core は decideResumeState が
// 参照する LAND_PHASE 定数のみ持つ。

import { spawnSync } from 'node:child_process';
import {
  REPO_ROOT, UNPARSABLE_VERDICT,
  MAX_LAND_REVIEW_REWORK_ROUNDS, LAND_REVIEW_MANIFEST_STAGE, LAND_REWORK_MANIFEST_STAGE,
  runStageWithUnparsableRetry, buildManifestEntry, backendCostSourceForEnvelope, tailLines,
  extractFirstCommitMessage, splitCommitMessage, buildPrBodyWithCloses,
  buildPrCreateArgs, buildPrMergeArgs,
} from './inner-loop-core.mjs';
import { buildLandReworkPrompt } from './inner-loop-prompts.mjs';
import {
  fetchPrDiff, truncateDiff, buildEngineReviewPrompt, spawnReviewerWithRetry,
  formatReviewComment, postReviewComment,
} from './review-engine.mjs';
import { runStage } from './inner-loop-stage-runner.mjs';

// --- Pure functions (#188: verdict 分岐・周回判定を export し unit test) ---

/**
 * LAND review verdict 分岐・周回判定。PASS → auto-merge を arm、CHANGES →
 * 修正周回（上限 maxReworkRounds、超過は escalation）、それ以外（ESCALATE・
 * 不正・unparsable）→ escalation。
 * @param {{ verdict: string|null, reworkRoundsUsed: number, maxReworkRounds?: number }} p
 * @returns {{ action: 'arm' | 'rework' } | { action: 'escalate', reason: string }}
 */
export function decideLandReviewAction({ verdict, reworkRoundsUsed, maxReworkRounds = MAX_LAND_REVIEW_REWORK_ROUNDS }) {
  if (verdict === 'PASS') return { action: 'arm' };
  if (verdict === 'CHANGES') {
    if (reworkRoundsUsed >= maxReworkRounds) {
      return { action: 'escalate', reason: `CHANGES after ${maxReworkRounds} rework round(s) — 修正周回上限超過` };
    }
    return { action: 'rework' };
  }
  return { action: 'escalate', reason: `invalid review verdict: ${verdict ?? '(none/unparsable)'}` };
}

/**
 * Parse a PR number from text carrying a GitHub PR URL (`gh pr create` prints
 * the created PR's URL on stdout). Last match wins; null when absent.
 * @param {string | null | undefined} text
 * @returns {number | null}
 */
export function parsePrNumberFromUrl(text) {
  const matches = [...String(text ?? '').matchAll(/\/pull\/(\d+)/g)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

/**
 * Latest TASK_PLAN plan comment text (the driver posts `## plan\n\n<plan>` on
 * PLAN_READY, ADR 0035 §1). LAND review の plan 照合 fallback: --resume で LAND
 * から直接再開すると planText がプロセス内に無いので issue comments から導出する
 * （状態は gh から導出 = ADR 0031）。
 * @param {Array<{ body?: string }> | null | undefined} comments
 * @returns {string | null}
 */
export function extractLatestPlanCommentText(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? '');
    const lines = body.split('\n');
    if ((lines[0] ?? '').trim() === '## plan') {
      const text = lines.slice(1).join('\n').trim();
      if (text) return text;
    }
  }
  return null;
}

// --- Landing orchestration (side effects; deps-injectable like the driver) ---

/**
 * Land `branch` onto main with review 前置 (#201 分類規則 3 実装):
 * push → PR 確保（既存 open PR 再利用 or gh pr create — auto-merge は arm しない）
 * → review 周回 → PASS で gh pr merge --auto --squash ／ CHANGES で差し戻し
 * （上限 maxReworkRounds）／ 超過・不正 verdict は失敗を返す（escalation の
 * issue 投影 = projectEscalation は driver の管轄）。
 * @param {{ branch: string, issueNumber: number, worktreePath: string,
 *           issue?: { title?: string, body?: string, comments?: Array<object> }|null,
 *           planText?: string|null, backend?: string, maxReworkRounds?: number }} p
 * @param {{ spawnSync?: Function, log?: (msg:string)=>void, recordManifestEntry?: Function,
 *           runStage?: Function, now?: Function }} deps
 * @returns {{ ok: true, prNumber: number, reworkRoundsUsed: number }
 *         | { ok: false, stage: string, verdict: string|null, excerpt: string, prNumber: number|null }}
 */
// Land `branch` onto main: push → gh pr create → gh pr merge --auto --squash
// (ADR 0026 §1-2 / ADR 0030 §3). The first commit's message becomes the PR
// title/body (with `Closes #<issue>` appended by default; callers that must
// NOT close the issue — e.g. the explains/ auto-PR, #201 分解 13, where the
// explain lifecycle is independent of the task lifecycle — inject
// `deps.buildPrBody` to produce a Refs-only body). The actual squash happens
// on GitHub after the CI gate (required check) goes green; review is recorded
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
  const prBody = (deps.buildPrBody ?? buildPrBodyWithCloses)(body, issueNumber);

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

export function landBranchWithReview(
  { branch, issueNumber, worktreePath, issue = null, planText = null, backend = 'claude', maxReworkRounds = MAX_LAND_REVIEW_REWORK_ROUNDS },
  deps = {},
) {
  const run = deps.spawnSync ?? spawnSync;
  const logFn = deps.log ?? (() => {});
  const record = deps.recordManifestEntry ?? (() => {});
  const runStageFn = deps.runStage ?? runStage;
  const now = deps.now ?? (() => Date.now());

  const worktreeHead = () => {
    const r = run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT });
    return r.status === 0 ? ((r.stdout ?? '').trim() || null) : null;
  };
  const fail = (stage, verdict, excerpt, pr = null) => ({
    ok: false, stage, verdict,
    prNumber: pr?.number ?? null,
    // #188 設計要求 5: 各周回の所見は marker 付き PR コメントとして投稿済みなので、
    // escalation レポートは PR を指すだけで全周回が comment 列として追跡できる。
    excerpt: pr
      ? `${excerpt}\n\n全周回の review 所見は PR #${pr.number}${pr.url ? ` (${pr.url})` : ''} の comment 列（marker 付き）として可追跡です。`
      : excerpt,
  });

  // 1. PR title/body from the first commit (旧 landBranch と同一の導出).
  const logR = run('git', ['log', '--reverse', '--format=%B%x00', `main..${branch}`], { encoding: 'utf8', cwd: REPO_ROOT });
  if (logR.status !== 0) return fail('LAND', null, `could not read commit messages for ${branch}: ${logR.stderr ?? ''}`);
  const { subject, body } = splitCommitMessage(extractFirstCommitMessage(logR.stdout ?? ''));
  if (!subject) return fail('LAND', null, `no commits found between main and ${branch} — nothing to land`);
  const prBody = buildPrBodyWithCloses(body, issueNumber);

  // 2. push (fast-forward only — force-push 禁止).
  const pushR = run('git', ['push', '-u', 'origin', branch], { encoding: 'utf8', cwd: REPO_ROOT });
  if (pushR.status !== 0) return fail('LAND', null, `git push failed — cannot create PR for ${branch}\n${tailLines(pushR.stderr ?? '')}`);

  // 3. PR 確保: 既存 open PR があれば再利用（新 PR を作らない — #188 設計要求 4。
  //    mid-LAND で死んだ run の再着地にも安全）。無ければ作成。auto-merge はここで
  //    arm しない（arm は review PASS 後だけ — #201 分解 11）。
  let pr = null;
  const listR = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title,body,headRefName,url'], { encoding: 'utf8', cwd: REPO_ROOT });
  if (listR.status === 0) {
    try { pr = (JSON.parse(listR.stdout) ?? [])[0] ?? null; } catch { pr = null; }
  }
  if (pr) {
    logFn(`LAND: reusing existing open PR #${pr.number} for ${branch}（新 PR を作らない）`);
  } else {
    const createR = run('gh', buildPrCreateArgs({ base: 'main', head: branch, title: subject, body: prBody }), { encoding: 'utf8', cwd: REPO_ROOT });
    if (createR.status !== 0) return fail('LAND', null, `gh pr create failed for ${branch}\n${tailLines(`${createR.stdout ?? ''}\n${createR.stderr ?? ''}`)}`);
    const prNumber = parsePrNumberFromUrl(`${createR.stdout ?? ''}\n${createR.stderr ?? ''}`);
    if (prNumber === null) return fail('LAND', null, `could not parse the PR number from gh pr create output for ${branch}`);
    pr = { number: prNumber, title: subject, body: prBody, headRefName: branch, url: ((createR.stdout ?? '').trim().split('\n').pop() || null) };
  }

  // 4. review 周回 (#201 分解 11-12). `previous` が所見の運搬経路（envelope を
  //    プロセス内で保持 — #188 設計要求 1。PR コメントは記録であって運搬ではない）。
  let reworkRoundsUsed = 0;
  let previous = null; // { findings, implementerResponse, headSha }
  while (true) {
    const reviewHeadSha = worktreeHead();
    const diffRaw = fetchPrDiff(pr.number, deps);
    if (diffRaw === null || !diffRaw.trim()) {
      return fail(LAND_REVIEW_MANIFEST_STAGE, null, `could not fetch a non-empty diff for PR #${pr.number}`, pr);
    }
    const { text: diffText, truncated: diffTruncated } = truncateDiff(diffRaw);
    let rereview = null;
    if (previous) {
      // #188 設計要求 3: 再 review は前回所見＋前回 head からの差分を文脈に持つ。
      const deltaR = run('git', ['-C', worktreePath, 'diff', `${previous.headSha}..HEAD`], { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 1e8 });
      const delta = truncateDiff(deltaR.status === 0 ? (deltaR.stdout ?? '') : '');
      rereview = {
        round: reworkRoundsUsed, maxRounds: maxReworkRounds,
        previousFindings: previous.findings,
        implementerResponse: previous.implementerResponse,
        previousHeadSha: previous.headSha,
        deltaDiffText: delta.text,
        deltaDiffTruncated: delta.truncated,
      };
    }
    const prompt = buildEngineReviewPrompt({
      pr, diffText, diffTruncated,
      issue: issue ? { number: issueNumber, title: issue.title, body: issue.body } : null,
      planText, rereview,
    });
    const reviewStartedAt = now();
    const { envelope, verdict } = spawnReviewerWithRetry(prompt, deps, {
      onRetry: () => logFn(`LAND review PR #${pr.number}: verdict unparsable -> retrying reviewer once`),
    });
    if (envelope === null) return fail(LAND_REVIEW_MANIFEST_STAGE, null, `reviewer spawn failed for PR #${pr.number}`, pr);
    record(buildManifestEntry({
      stage: LAND_REVIEW_MANIFEST_STAGE,
      sessionId: envelope.session_id ?? null,
      verdict: verdict ?? UNPARSABLE_VERDICT,
      backendCostUsd: envelope.total_cost_usd ?? null,
      backendCostSource: backendCostSourceForEnvelope({ backend: 'claude' }),
      durationMs: Math.max(1, now() - reviewStartedAt),
      backend: 'claude',
      headSha: reviewHeadSha,
      resultText: envelope.result ?? '',
    }));
    if (verdict !== null) {
      // 記録 (#188 設計要求 5): 各周回の所見 = marker 付き PR コメント。投稿失敗は
      // 非致命 — 運搬は envelope（上の `previous`）なので周回を止めない（設計要求 1）。
      const posted = postReviewComment(pr.number, formatReviewComment({ verdict, resultText: envelope.result ?? '' }), deps);
      if (!posted) logFn(`warning: LAND review comment post failed for PR #${pr.number}（非致命 — 所見の運搬は envelope 保持）`);
    }
    const action = decideLandReviewAction({ verdict, reworkRoundsUsed, maxReworkRounds });
    logFn(`LAND review PR #${pr.number}: verdict=${verdict ?? '(unparsable)'} rework=${reworkRoundsUsed}/${maxReworkRounds} -> ${action.action}`);

    if (action.action === 'arm') {
      // #201 分解 11: PASS で初めて auto-merge を arm する。
      const mergeR = run('gh', buildPrMergeArgs({ branch }), { encoding: 'utf8', cwd: REPO_ROOT });
      if (mergeR.status !== 0) return fail('LAND', 'PASS', `gh pr merge --auto failed for ${branch}\n${tailLines(`${mergeR.stdout ?? ''}\n${mergeR.stderr ?? ''}`)}`, pr);
      return { ok: true, prNumber: pr.number, reworkRoundsUsed };
    }
    if (action.action === 'escalate') {
      return fail(LAND_REVIEW_MANIFEST_STAGE, verdict ?? UNPARSABLE_VERDICT, `LAND review: ${action.reason}\n\n${tailLines(envelope.result ?? '')}`, pr);
    }

    // CHANGES 差し戻し (#201 分解 12): 所見を IMPLEMENT へ注入し、同一 worktree で
    // 追い commit（#188 設計要求 2/4）。
    reworkRoundsUsed += 1;
    const reworkBaseSha = reviewHeadSha;
    const reworkPrompt = buildLandReworkPrompt({
      issueNumber,
      issueTitle: issue?.title ?? '', issueBody: issue?.body ?? '', comments: issue?.comments,
      reviewFeedback: envelope.result ?? '',
      round: reworkRoundsUsed, maxRounds: maxReworkRounds, prNumber: pr.number,
    });
    logFn(`LAND rework: CHANGES 差し戻し → IMPLEMENT（同一 worktree 追い commit, round ${reworkRoundsUsed}/${maxReworkRounds}）`);
    const reworkResult = runStageWithUnparsableRetry({
      runAttempt: () => {
        const stageStartedAt = now();
        const reworkEnvelope = runStageFn('IMPLEMENT', reworkPrompt, worktreePath, null, backend, deps);
        return { envelope: reworkEnvelope, durationMs: Math.max(1, now() - stageStartedAt), stageHeadSha: worktreeHead() };
      },
      recordAttempt: ({ envelope: reworkEnvelope, manifestVerdict, durationMs, stageHeadSha }) => {
        record(buildManifestEntry({
          stage: LAND_REWORK_MANIFEST_STAGE,
          sessionId: reworkEnvelope.session_id ?? null,
          verdict: manifestVerdict,
          backendCostUsd: reworkEnvelope.total_cost_usd ?? null,
          backendCostSource: backendCostSourceForEnvelope(reworkEnvelope),
          backendModel: reworkEnvelope.backend_model ?? null,
          backendTokenUsage: reworkEnvelope.backend_token_usage ?? null,
          durationMs,
          backend: reworkEnvelope.backend ?? null,
          headSha: stageHeadSha,
          resultText: reworkEnvelope.result ?? '',
        }));
      },
      onRetry: () => logFn(`LAND rework verdict=${UNPARSABLE_VERDICT} -> retrying same stage once`),
    });
    if (reworkResult.verdict !== 'IMPL_DONE') {
      return fail(LAND_REWORK_MANIFEST_STAGE, reworkResult.verdict ?? UNPARSABLE_VERDICT,
        `LAND rework did not complete (verdict: ${reworkResult.verdict ?? '(none/unparsable)'})\n\n${tailLines(reworkResult.envelope?.result ?? '')}`, pr);
    }
    const reworkHeadSha = reworkResult.stageHeadSha;
    if (reworkHeadSha && reworkHeadSha !== reworkBaseSha) {
      // 追い commit を fast-forward push — 既存 PR が自動更新される（新 PR を作らない）。
      const reworkPushR = run('git', ['push', 'origin', branch], { encoding: 'utf8', cwd: REPO_ROOT });
      if (reworkPushR.status !== 0) {
        return fail(LAND_REWORK_MANIFEST_STAGE, 'IMPL_DONE', `git push failed after rework for ${branch}\n${tailLines(reworkPushR.stderr ?? '')}`, pr);
      }
      logFn(`LAND rework: pushed ${branch} — PR #${pr.number} updated`);
    } else {
      // zero-commit rework = 全指摘を理由付きで却下した対応表明（#188 設計要求 2）。
      // push は不要 — 対応表明を rereview 文脈に載せて再 review が裁く。
      logFn('LAND rework: zero new commits — 対応表明のみ。push せず再 review に渡す');
    }
    previous = { findings: envelope.result ?? '', implementerResponse: reworkResult.envelope?.result ?? '', headSha: reworkBaseSha };
  }
}
