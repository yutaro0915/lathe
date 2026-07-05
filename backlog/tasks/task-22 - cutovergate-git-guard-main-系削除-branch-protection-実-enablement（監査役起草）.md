---
id: TASK-22
title: 'cutover(gate): git-guard main 系削除 + branch protection 実 enablement（監査役起草）'
status: Done
assignee: []
created_date: '2026-07-04 18:07'
updated_date: '2026-07-05 05:17'
labels: []
dependencies: []
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p1-high

## 申請（ADR 0027 intake・PdM 承認済み: 2026-07-05 会話で復旧手順として承認）

ADR 0026 §1-3 cutover の外部空間スライス。**監査役が PR で起草**する（.claude/hooks/ は inner に触らせない = task-16 REVIEW blocker の裁定）。

- (a) .claude/hooks/git-guard.mjs の main 系列挙ルール（cherry-pick / merge / commit prefix / shouldBlockOnMain）を削除し、broad-add / force-push の助言 block のみ残す
- (b) branch protection を実際に有効化: 直 push 拒否（pull_request rule type）+ required status check = CI gate + auto-merge 許可。**ADR 0028 により required review は不採用**。gh api コマンドと設定内容を design/runbooks/ に記録
- (c) enablement は receipt 削除系スライスの着地後の最終手順とし、直前に PdM 確認

依存: TASK-16 と receipt 物理削除（前 issue）。出自: 旧 TASK-20 → ADR 0027 受付へ再登記。

---
intake: issue #77 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
完了（2026-07-05）: (1) git-guard の main 系ルール（cherry-pick/merge/コードパス commit の shouldBlockOnMain）を strip、broad-add/force-push の助言のみ残す（#123 で staging 漏れ→#124 で redo 着地）。(2) branch protection 有効化（required check=gate / enforce_admins=true / required_reviews=none、ADR 0028）。直 push が GH006 で拒否されることを実測確認。これで「main の唯一の入口 = PR + CI GREEN・例外なし（人間も監査役も agent も）」が物理強制された。ADR 0026 単一ゲート化の完了。
<!-- SECTION:NOTES:END -->
