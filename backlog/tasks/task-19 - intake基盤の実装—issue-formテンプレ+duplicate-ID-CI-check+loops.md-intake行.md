---
id: TASK-19
title: intake 基盤の実装 — issue form テンプレ + duplicate-ID CI check + loops.md intake 行
status: To Do
assignee: []
created_date: '2026-07-04 17:07'
updated_date: '2026-07-04 17:07'
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
- [ ] #1 .github/ISSUE_TEMPLATE/task-request.yml（issue form・必須: 目的/意味・効能=PdM 共有の参照/AC/labels/priority/deps・label task-request 自動付与）
- [ ] #2 CI に duplicate-task-ID check（backlog/tasks 内の ID 重複で RED。並走 intake PR の再採番を機械強制）
- [ ] #3 design/loops.md に intake loop の行を追加（ADR 0027 §4 の表・loop 追加承認は ADR が兼ねる）
- [ ] #4 design/runbooks/ に intake 運用（routine の指示文正本・フィルター/権限/model=haiku の設定記録）
- [ ] #5 起票元の切替は別 task（plan-loop / meta ACT の issue 投函化）＝本 task のスコープ外
<!-- AC:END -->
