// inner-loop-config.mjs — driver（inner-loop 系）の運用パラメータ集約
// (ADR 0030 §5 · issue #118)
//
// ここに数値定数を集め、driver 各モジュールはここからインポートする。
// 運用パラメータの変更はここだけ触ればよい（ハードコード撲滅）。

// unparsable verdict（"UNPARSABLE"）を再試行する最大回数。
// stage runner（inner-loop-core.mjs）と meta-loop.mjs が共用する。
export const MAX_UNPARSABLE_STAGE_RETRIES = 1;

// PLAN_REVIEW が RED を返したとき TASK_PLAN をリトライする上限。
// 超過時は needs-review + escalation label を投影して停止（ADR 0035 §5）。
export const MAX_PLAN_REVIEW_RETRIES = 2;

// LAND review 前置の CHANGES 差し戻し修正周回上限（#201 分解 11-12 / #188）。
// 超過は escalation（分岐は inner-loop-land.mjs decideLandReviewAction）。
export const MAX_LAND_REVIEW_REWORK_ROUNDS = 2;

// FILE_CHILDREN 書式検証 NG → PLAN 差し戻しの修正周回上限。
// planner 書式逸脱を escalate 即死させず informed retry を 1 周だけ許す。
// 再 NG は escalation（分岐は decidePlanValidationAction）。
export const MAX_PLAN_CHILDREN_VALIDATION_RETRIES = 1;

// review-engine: spawnReviewerWithRetry で unparsable verdict を再試行する上限。
export const MAX_UNPARSABLE_RETRIES = 1;

// review-engine: gh pr diff を截断する文字数上限。
export const DIFF_CHAR_LIMIT = 120_000;
