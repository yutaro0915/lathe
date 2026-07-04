---
id: TASK-15
title: 'feat(gate): CI rubric-gate + merge.mjs の PR 着地化（ADR 0026 §1）'
status: Done
assignee: []
created_date: '2026-07-04 16:07'
updated_date: '2026-07-04 16:39'
labels: []
milestone: m-18
dependencies: []
priority: high
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
着地の単一ゲート化の前半（build 段。旧ゲートのまま着地し、二重期間は両立させる）。正本 adr/0026-single-landing-gate-and-simplification.md §1-2。(a) GitHub Actions で PR に対し rubrics/run.mjs --changed（tier test 以上）+ unit を再実行し、PR head sha の status check にする（既存 CI の rubric-gate step が no-op している問題＝TASK-6 の解消を含む）。(b) merge.mjs を『ローカル squash』から『branch push → gh pr create → gh pr merge --auto --squash』へ縮小。receipt 検査は TASK-14 まで残置。(c) inner-loop driver の MERGE 段が新 merge.mjs で完走すること（manifest 契約は不変）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PR を開くと CI が rubric gate + unit を PR head sha で実行し、fail が status check で見える
- [ ] #2 merge.mjs が branch push → PR 作成 → auto-merge 設定を行う（ローカル squash 廃止）
- [ ] #3 inner-loop の MERGE 段が新 merge.mjs 経由で task を完走する（manifest 契約不変）
- [ ] #4 CI の rubric-gate が same-SHA push で no-op しない（TASK-6 の再現条件で GREEN/RED が正しく出る）
<!-- AC:END -->
