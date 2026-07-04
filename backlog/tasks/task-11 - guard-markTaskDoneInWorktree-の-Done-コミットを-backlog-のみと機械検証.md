---
id: TASK-11
title: 'guard: markTaskDoneInWorktree の Done コミットを backlog/ のみと機械検証'
status: Done
assignee: []
created_date: '2026-07-04 13:42'
updated_date: '2026-07-04 13:58'
labels:
  - phase-2
  - guard
dependencies: []
priority: medium
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-1.2 レビューの minor 指摘。scripts/inner-loop.mjs の markTaskDoneInWorktree は Done コミット作成後に receipt を新 sha へ再スタンプするが、コミット内容が backlog/ 配下のみであることを機械検証していない（git add backlog/ という手続き上の限定のみ）。Done コミット直後に git diff --name-only <before>..<after> を検証し、backlog/ 以外のパスを含む場合は receipt を再スタンプせず fail（escalation）するガードを追加する。小変更・scripts のみ。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Done コミットの diff paths が backlog/ のみであることを検証し、逸脱時は receipt 再スタンプせず fail する
- [ ] #2 正常ケース・逸脱ケースのユニットテストを追加
- [ ] #3 既存テスト退行なし（pnpm test GREEN）
<!-- AC:END -->
