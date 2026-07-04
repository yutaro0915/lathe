---
id: TASK-16
title: >-
  cutover(gate): branch protection 有効化 + receipt 制度・git-guard main 系の削除（ADR 0026
  §1-3、TASK-6 吸収）
status: To Do
assignee: []
created_date: '2026-07-04 16:08'
labels: []
milestone: m-18
dependencies:
  - TASK-15
priority: high
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
単一ゲート化の後半（cutover 段）。正本 adr/0026-single-landing-gate-and-simplification.md。(a) main への直接 push を branch protection / ruleset で禁止（required check = CI rubric-gate。設定手順 or gh api コマンドを repo に記録）。(b) 削除: scripts/receipt.mjs / merge.mjs の receipt 検査と backstop / markTaskDoneInWorktree の receipt 再スタンプ & backlog-only guard / .claude/hooks/git-guard.mjs の main 系列挙ルール（cherry-pick・merge・commit prefix。broad add と force-push 助言は残す）。テストを追随削除・追加。(c) reviewer の verdict+本文を PR review として投稿する経路に置換。(d) TASK-6 はこの CI 構成で解消を確認し Done にする。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 main への直接 push が origin で拒否される（設定内容が repo 内に文書化されている）
- [ ] #2 receipt.mjs / lathe-receipts 参照 / 再スタンプ / backlog-only guard / git-guard main 系ルールが削除され、テストが GREEN
- [ ] #3 review の verdict と本文が PR review としてサーバー側に残る
- [ ] #4 inner-loop が task 1 件を新ゲートで完走する（live-fire）
<!-- AC:END -->
