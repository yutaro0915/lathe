---
id: TASK-16
title: >-
  cutover(gate): branch protection 有効化 + receipt 制度・git-guard main 系の削除（ADR 0026
  §1-3、TASK-6 吸収）
status: Done
assignee: []
created_date: '2026-07-04 16:08'
updated_date: '2026-07-05 04:12'
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
- [ ] #1 review の verdict と本文が PR review としてサーバー側に残る
- [ ] #2 inner-loop が task 1 件を新ゲートで完走する（live-fire）
- [ ] #3 inner-loop.mjs と merge.mjs が receipt を読まず書かず、review verdict+本文が PR review として投稿される（receipt.mjs ファイル自体は issue #76 の後続 task まで残置）
- [ ] #4 markTaskDoneInWorktree の receipt 再スタンプと backlog-only guard が削除され、テストが追随して GREEN
<!-- AC:END -->







## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PdM 裁定 2026-07-05（task-16 escalation 対応・スライス再構成）: (1) .claude/hooks/git-guard.mjs への変更は本スライスから除外（外部空間 = REVIEW blocker。監査役が issue #77 経由の別 PR で起草）。(2) scripts/receipt.mjs / receipt.test.mjs の物理削除も除外（bootstrap: 現行 driver が worktree の receipt.mjs で verdict を刻むため、削除すると driver 自身が crash — 本 run で実証。削除は issue #76 → 後続 task）。(3) 本スライスに残すもの = inner-loop.mjs / merge.mjs の receipt 脱使用（PR review 投稿への置換 — ただし ADR 0028 で required review 不採用、投稿は記録目的）+ markTaskDoneInWorktree の再スタンプ & backlog-only guard 削除 + /tmp reviewBody の finally 掃除。(4) branch protection 実施は issue #77 の最終手順へ移管。(5) 空洞完走の driver 欠陥は issue #78。前回 run は空洞完走検知により破棄済み・worktree/manifest 掃除済み・fresh 再走可。
<!-- SECTION:NOTES:END -->
