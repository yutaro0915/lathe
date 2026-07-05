---
id: TASK-33
title: 'ADR 0030 ③: task loop の縮退 — PLAN／TRIAGE 段の削除と plan-task 型の導入'
status: To Do
assignee: []
created_date: '2026-07-05 05:02'
updated_date: '2026-07-05 06:37'
labels: []
dependencies: []
priority: medium
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
task loop が 6 段 1 本で長すぎ、途中成果物がログしかなく、失敗の切り分けと比較実験ができない。PLAN 段は plan-task と重複。TRIAGE は escalation 判断の分散点。

## 方針（ADR 0030 §2 後半・§3）
- task loop のローカル段を IMPLEMENT（worktree）→ PR 作成に縮退。PLAN 段・TRIAGE 段を削除
- review は PR 上（TASK-16 方式の正式化）。auto-merge arm は reviewer PASS 後の順序を driver が担保
- plan-task 型を driver に導入: 終端 = plan 確定＋子 issue 投函（intake へ還流）。issue 起点の独立 plan-loop コードは削除
- 依存: ADR 0030 ①（intake の振り分けが先）、②（merge 経路の単純化が先）

## 検証
- plan-task の実走: plan 無し issue → plan-task → 子 issue 投函 → intake 登記の一巡
- 実装 task の実走: IMPLEMENT→PR→CI→PR review→着地の完走

---
intake: issue #116 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ADR 0030 追記 B（2026-07-05 PdM 裁定）: PR review は gh 上ホスト実行ではなく、review 待ち PR を拾ってローカルで reviewer を自動駆動する engine 方式（transcript 保存＝ingest 目的）。engine は task loop から独立の新規コンポーネント（別 task で実装）。本 task の縮退設計は engine の存在を前提に読み替えること。

ADR 0031（2026-07-05 PdM 裁定）: 着手禁止。task 正本は GitHub Issues へ移行（Backlog.md 廃止）。本 task の内容は移行後に issue 上で再定義する（ADR 0030 の決定は不変・substrate のみ変更）。
<!-- SECTION:NOTES:END -->
