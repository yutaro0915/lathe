---
id: TASK-34
title: >-
  ADR 0031 移行: task 正本を GitHub Issues へ — backlog/ 廃止・intake 写し停止・open task の
  issue 化
status: To Do
assignee: []
created_date: '2026-07-05 06:38'
labels: []
dependencies: []
priority: medium
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
task 正本が repo 内 backlog/ にあり、worktree コピーの同期事故と status 変更ごとの帳簿 PR が発生する（ADR 0031 背景）。

## 方針（ADR 0031）
実施順:
1. open な backlog task を issue 化する（intake 由来のものは元 issue の reopen＋本文へ task notes の裁定を転記。それ以外は新規 issue 起こし）。Done task は移行しない（歴史は git 履歴に残る）
2. intake Action の「issue → backlog task 写し」機能を停止（label まわりの将来拡張は issue のまま扱う）
3. task-id-unique CI check（TASK-19 成果物）を削除
4. driver / inner-queue の backlog CLI 結線を除去（TASK-33 の縮退書き直しと統合してよい）
5. backlog/ ディレクトリと Backlog.md 設定を削除
6. loops.md / agent-workflow.md / runbook の起票・status 記述を追随（status は導出: open=To Do / 参照 PR open=In Progress / merge+close=Done。blocked-by #N 記法）

## 検証
- gh issue list で全 open task が見え、backlog/ が存在しないこと
- 新規 task-request issue がそのまま task として扱われる（写しが発生しない）こと
- CI が backlog 関連 check なしで GREEN であること

---
intake: issue #136 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
