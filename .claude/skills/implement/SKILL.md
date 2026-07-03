---
name: implement
description: Lathe implementer workflow for bounded code changes in an inner-loop worktree. Keeps the branch current with local main before implementation and review handoff.
grounded_in: []
---

# implement — inner-loop implementation discipline

implementer agent がこれに従う。scope は issue / approved plan / review feedback に限定し、main worktree や別 worktree へ書かない。

## main freshness

- **着手前**: 現在の local `main` を基準にする。既存コミットがある通常の inner branch では、編集前に対象 worktree 内で `git rebase main` を実行する。
- **pristine な開始状態だけ例外**: まだ成果物が無く、branch を捨ててもよい開始直後だけ `git reset --hard main` を使ってよい。
- **禁止**: 編集後・コミット後に `git reset --hard main` で成果物を消す運用は禁止。成果物がある状態で main へ合わせる時は `git rebase main` を使う。
- **review handoff 前**: 実装を 1 commit にまとめた後、review に渡す前にも `git rebase main` を実行し、branch tip を rebase 済みの merged-main 実体にする。
- `git rebase main` が競合した場合は自力で契約を作らず、実装を継続せずに `ESCALATE` する。

## implementation

- plan / acceptance criteria / review feedback だけを対象に、最小の互換変更を行う。
- 差し戻し由来で設計軸が未定義（契約・ロール割当・規約新設など）なら、最小変更を発明せず `ESCALATE` する。
- 1 commit にまとめる。staging は明示 `git add <paths>` を使い、`git add -A` / `git add .` は使わない。
- 実 exit code を確認して検証する。未確認の GREEN を報告しない。
