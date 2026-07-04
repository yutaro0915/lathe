---
id: TASK-21
title: 'chore(gate): receipt.mjs / receipt.test.mjs の物理削除（TASK-16 の後始末・bootstrap 制約つき）'
status: To Do
assignee: []
created_date: '2026-07-04 18:05'
labels: []
dependencies: []
priority: medium
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p2-normal

## 申請（ADR 0027 intake・PdM 承認済み: 2026-07-05 会話で復旧手順として承認）

TASK-16 で inner-loop.mjs / merge.mjs が receipt を読まなく・書かなくなった**後**の死骸掃除。scripts/receipt.mjs / scripts/receipt.test.mjs を削除し、残存参照ゼロを確認する。

**bootstrap 制約（重要・実証済み）**: TASK-16 と同一スライスで削除してはならない。現行 driver は REVIEW verdict を worktree の receipt.mjs で刻むため、worktree 内で削除すると driver 自身が MODULE_NOT_FOUND で crash する（2026-07-05 task-16 escalation で実証）。**新 driver（TASK-16 着地版）で走る後続 task として登記**すること（依存: TASK-16）。

出自: 旧 TASK-19 として直接起票 → 並行セッションの intake TASK-19 と ID 衝突 → ADR 0027 受付へ再登記。

---
intake: issue #76 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
