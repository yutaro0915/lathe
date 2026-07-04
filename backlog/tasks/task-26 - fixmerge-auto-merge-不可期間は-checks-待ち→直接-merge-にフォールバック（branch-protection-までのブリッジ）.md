---
id: TASK-26
title: >-
  fix(merge): auto-merge 不可期間は checks 待ち→直接 merge にフォールバック（branch protection
  までのブリッジ）
status: To Do
assignee: []
created_date: '2026-07-04 18:37'
labels: []
dependencies: []
priority: medium
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p1-high

## 申請（intake・原因と解決が明確な機械修正。2026-07-05 夜間の TASK-20 で実証）

`scripts/merge.mjs` は receipt チェック → PR 作成 → `gh pr merge --auto --squash` の順で着地する。しかし **`--auto` は required status check（＝branch protection）が有効でないと張れず**、check の無い PR は即「clean status」になって `enablePullRequestAutoMerge` が GraphQL エラーで失敗する（2026-07-05、TASK-20 #93 で MERGE 段が escalation）。branch protection の有効化は TASK-22（PdM 確認事項）まで先なので、それまで全 inner loop の merge が止まる。

## やること（.github/workflows/intake.yml に既に前例あり）
- merge.mjs の最終着地を「`gh pr merge --auto --squash` を試し、失敗したら `gh pr checks <branch> --watch` で CI 完了を待ってから `gh pr merge --squash --delete-branch`」に変更。
- `--auto` を primary に残す（branch protection 有効化後はそのまま効く）。fallback は check 完了後にのみ merge するので**ゲート（CI green）は保たれる**（receipt チェックは既存のまま前段に残す）。
- unit 追随（該当関数のモック fallback 分岐）。

## 受け入れ
- branch protection 無効の現状で、inner loop の PR が CI green 後に自動 merge される（TASK-20 で起きた escalation が再現しない）。

---
intake: issue #94 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
