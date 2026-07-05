---
id: TASK-30
title: 'ADR 0030 ②: merge.mjs 解体 — receipt 検査・backstop・landing lock を削除し driver 直呼びへ'
status: To Do
assignee: []
created_date: '2026-07-05 05:00'
updated_date: '2026-07-05 06:37'
labels: []
dependencies: []
priority: medium
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
merge.mjs の receipt 検査は廃止決定済みの遺物（ADR 0026）、backstop は CI と完全重複、landing lock は PR 化で不要。旧ゲートと新ゲートが同居している。

## 方針（ADR 0030 §3）
- merge.mjs を解体: receipt 検査・backstop（rubrics/run.mjs 再実行）・landing lock を削除
- 残る push／gh pr create／auto-merge arm（＋protection 無し期間の checks-watch フォールバック＝TASK-26/27/28 の成果を継承）は driver（inner-loop.mjs）が直接実行
- TASK-21（receipt.mjs 物理削除）と連続して実施。依存: ADR 0030 ①の後が望ましいが独立実行可

## 検証
- task loop の実走で PR 作成→CI GREEN→着地が merge.mjs 無しで完走すること
- unit: merge.mjs 由来のテストの整理（削除機能のテストは削除、移設機能のテストは移設）

---
intake: issue #115 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ADR 0031（2026-07-05 PdM 裁定）: 着手禁止。task 正本は GitHub Issues へ移行（Backlog.md 廃止）。本 task の内容は移行後に issue 上で再定義する（ADR 0030 の決定は不変・substrate のみ変更）。
<!-- SECTION:NOTES:END -->
