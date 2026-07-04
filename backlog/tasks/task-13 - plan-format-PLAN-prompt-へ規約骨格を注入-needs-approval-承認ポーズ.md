---
id: TASK-13
title: 'plan-format: PLAN prompt へ規約骨格を注入 + needs-approval 承認ポーズ'
status: To Do
assignee: []
created_date: '2026-07-04 15:56'
labels:
  - loop
  - plan-format
dependencies: []
references:
  - design/plan-format.md
priority: high
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
design/plan-format.md（正本）を loop 機構に落とす。(1) PLAN prompt に5セクション骨格＋スケール規則＋設計原則の短い skeleton を注入（全文 inline せず正本参照）。(2) label 'needs-approval' を持つ task は PLAN_READY 後に driver が停止し PdM 承認を待つ。既存 resume 機構で IMPLEMENT から再開。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PLAN prompt が plan-format の骨格（問題/選択肢/方針/契約/検証＋スケール規則＋設計原則）を注入する
- [ ] #2 needs-approval 付き task は PLAN_READY で停止し、resume で IMPLEMENT から再開できる
- [ ] #3 trivial クラス（軽量形）の既存挙動は変えない・既存テスト退行なし
<!-- AC:END -->
