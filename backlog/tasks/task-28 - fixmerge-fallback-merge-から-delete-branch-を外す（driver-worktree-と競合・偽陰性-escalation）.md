---
id: TASK-28
title: >-
  fix(merge): fallback merge から --delete-branch を外す（driver worktree と競合・偽陰性
  escalation）
status: Done
assignee: []
created_date: '2026-07-04 20:11'
updated_date: '2026-07-04 20:22'
labels: []
dependencies: []
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p1-high（label 未作成のため body）

## 申請（intake・原因と解決が明確な機械修正。2026-07-05 TASK-24 #101 で実証）

`scripts/merge.mjs` の fallback merge が `gh pr merge --squash --delete-branch` を使うが、driver 経由では merge.mjs 実行時にまだ **driver の worktree が branch を checked out 中**のため `--delete-branch` のローカル branch 削除が `cannot delete branch 'inner/task-N' used by worktree` で失敗する。**PR 自体は merge 成功しているのに** gh が非ゼロを返し、merge.mjs が `die("gh pr merge (fallback) failed")` → 偽陰性 escalation。task は着地済みなのに毎回 escalation が出て手動掃除が要る。

## やること
- `buildPrMergeFallbackArgs` と `buildPrMergeArgs`（--auto 版）から **`--delete-branch` を外す**。remote branch は repo 設定 `delete_branch_on_merge:true` が自動削除、local branch と worktree は driver の `cleanupWorktree` が既に処理する。
- 防御的に: fallback merge が非ゼロでも、直後に PR state を確認して MERGED なら成功扱いにする（任意・スコープが膨らむなら --delete-branch 除去のみで可）。
- unit 追随。

## 受け入れ
- driver 経由の inner loop が escalation なしで自己完結する（TASK-24 の偽陰性が再現しない）。

---
intake: issue #102 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
