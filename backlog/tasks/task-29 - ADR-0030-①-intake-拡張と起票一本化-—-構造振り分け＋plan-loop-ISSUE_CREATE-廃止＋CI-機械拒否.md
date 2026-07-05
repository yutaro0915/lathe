---
id: TASK-29
title: 'ADR 0030 ①: intake 拡張と起票一本化 — 構造振り分け＋plan-loop ISSUE_CREATE 廃止＋CI 機械拒否'
status: To Do
assignee: []
created_date: '2026-07-05 05:00'
labels: []
dependencies: []
priority: medium
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
起票経路が 3 本（intake／plan-loop 直接 backlog task create／手起票）あり、単一 writer（ADR 0027)と plan 通過が保証されない。

## 方針（ADR 0030 §1–2 前半）
- intake Action に構造振り分けを追加: issue 本文が plan-format 必須節（問題/方針/検証）を備え粒度規準内なら実装 task、それ以外は plan-task として登記（却下ゼロ維持・判断ゼロ維持）
- scripts/inner-loop.mjs の plan-loop ISSUE_CREATE 段の直接 backlog task create を廃止し、issue 投函に置換
- CI: backlog/tasks/ への新規 task ファイル追加を含む PR は intake 由来以外を拒否（task-id-unique check＝TASK-19 の拡張。既存 task の status/notes 編集は可）

## 検証
- plan 付き小 issue → 実装 task、plan 無し issue → plan-task に登記されることを実 issue で確認
- intake 以外の新規 task 追加 PR が CI RED になることを確認

---
intake: issue #113 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
