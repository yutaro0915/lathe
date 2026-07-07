// inner-loop-escalation-triage.mjs — escalation triage 分類（#117, ADR 0035 §4）。
// 単一出口（escalateIssue）の直後に挟まれ、escalation を 2 値に分類する。
//
// (i) 'context'（コンテキスト不足 / UNPARSABLE）は出口前の bounded-retry
//     （runStageWithUnparsableRetry）が吸収するため、ここには現れない。
//     bounded-retry 上限超過時は 'decision' として扱う。
// (ii) 'environment' — 環境要因（REBASE_CONFLICT / MAIN_DIRTY_BACKSTOP）→
//     driver が修理 task-request issue を起票し、元 issue に escalation label を
//     付与しない（自動吸収可能な事象を PdM 裁定キューに流さない）。
// (iii) 'decision' — 意思決定が必要（exhausted retries / hollow / 等）→
//     driver が needs-review label を付与し、orchestrator が EXPLAIN dispatch。

/**
 * Classify an escalation into 2 categories (ADR 0035 §4).
 * @param {{ verdict: string|null }} p
 * @returns {'environment'|'decision'}
 */
export function classifyEscalation({ verdict }) {
  if (verdict === 'REBASE_CONFLICT') return 'environment';
  if (verdict === 'MAIN_DIRTY_BACKSTOP') return 'environment';
  return 'decision';
}
