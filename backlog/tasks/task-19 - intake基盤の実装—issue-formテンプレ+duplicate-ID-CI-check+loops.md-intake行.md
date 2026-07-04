---
id: TASK-19
title: intake 基盤の実装 — issue form テンプレ + duplicate-ID CI check + loops.md intake 行
status: To Do
assignee: []
created_date: '2026-07-04 17:07'
updated_date: '2026-07-04 18:02'
labels:
  - loop
  - intake
milestone: m-18
dependencies:
  - TASK-16
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ADR 0027（accepted・PR #67）の intake loop を稼働させる repo 側の実装。registrar 本体は Claude routine（Issue opened トリガー・PdM 設定済み）が担うため、本 task は routine が依拠する機械部分のみ。

2026-07-05 PdM 壁打ちで承認（intake は PdM 発案、routine 形も PdM 選定）。backlog task 発行の単一 writer 化により、outer 並走での ID 衝突（TASK-12 実例）と PR 経由起票の構造的衝突を解消する。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CI に duplicate-task-ID check（backlog/tasks 内の ID 重複で RED。並走 intake PR の再採番を機械強制）
- [ ] #2 起票元の切替は別 task（plan-loop / meta ACT の issue 投函化）＝本 task のスコープ外
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
再スコープ（ADR 0027 追記・2026-07-05 PdM 裁定）: 登記は LLM routine から GitHub Action（.github/workflows/intake.yml・判断ゼロ）に置換済み。issue form テンプレ・routine 指示文正本・loops.md 行は不要化/実施済み（feat/intake-action PR）。残スコープ = duplicate-task-ID CI check のみ。
<!-- SECTION:NOTES:END -->
