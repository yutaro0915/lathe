// inner-loop-config.mjs — driver（inner-loop 系）の運用パラメータ集約
// (ADR 0030 §5 · issue #118)
//
// ここに数値定数を集め、driver 各モジュールはここからインポートする。
// 運用パラメータの変更はここだけ触ればよい（ハードコード撲滅）。
// 参照形式: `import { DRIVER_CONFIG } from './inner-loop-config.mjs';`
//           `DRIVER_CONFIG.<field>` でアクセスする。
// 再エクスポート shim を作らないこと（二重入口禁止・plan §4）。

/**
 * Driver operational parameters — single source of truth (ADR 0030 §5).
 * All fields are camelCase. Reference as DRIVER_CONFIG.<field>.
 */
export const DRIVER_CONFIG = Object.freeze({
  /** unparsable verdict（"UNPARSABLE"）の再試行上限。
   *  core（runStageWithUnparsableRetry）と review-engine（spawnReviewerWithRetry）で共用。
   *  旧 MAX_UNPARSABLE_STAGE_RETRIES（core）と MAX_UNPARSABLE_RETRIES（review-engine）を統合。 */
  maxUnparsableStageRetries: 1,
  /** PLAN_REVIEW RED 時の TASK_PLAN リトライ上限。超過時は needs-review + escalation（ADR 0035 §5）。 */
  maxPlanReviewRetries: 2,
  /** LAND review 前置の CHANGES 差し戻し修正周回上限（#201 分解 11-12 / #188）。超過は escalation。 */
  maxLandReviewReworkRounds: 2,
  /** FILE_CHILDREN 書式検証 NG → PLAN 差し戻しの修正周回上限。再 NG は escalation。 */
  maxPlanChildrenValidationRetries: 1,
});
