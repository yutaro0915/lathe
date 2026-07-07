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

import {
  MAX_LAND_REVIEW_REWORK_ROUNDS,
} from './inner-loop-core.mjs';

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
