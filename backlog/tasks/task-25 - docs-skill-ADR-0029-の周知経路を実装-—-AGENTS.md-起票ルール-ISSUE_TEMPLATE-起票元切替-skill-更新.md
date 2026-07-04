---
id: TASK-25
title: >-
  docs/skill: ADR 0029 の周知経路を実装 — AGENTS.md 起票ルール + ISSUE_TEMPLATE + 起票元切替 +
  skill 更新
status: Done
assignee: []
created_date: '2026-07-04 18:17'
updated_date: '2026-07-04 22:47'
labels: []
dependencies: []
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 申請（PdM 指示 2026-07-05・ADR 0029 の実装）

正本 = adr/0029-task-ops-and-agent-awareness.md。「起票の唯一 UX（gh issue + task-request label）」を人と agent に届く構造にする。

## スコープ（ADR 0029 §実装）
- (a) **AGENTS.md**: 起票ルール 1〜2 行 + design/loops.md へのポインタを追記（予算 150 行・instruction-lint 内。手順は書かずポインタのみ）。**指示空間につき監査役起草**
- (b) **.github/ISSUE_TEMPLATE/task-request.md**: 便宜テンプレ。`labels: [task-request]` の自動付与のみで、必須フィールドは置かない（却下ゼロ原則 = ADR 0027 追記）
- (c) **起票元の切替**: plan-loop（ISSUE_CREATE 段）と meta ACT 系の task 発行を `backlog task create` 直呼びから issue 投函（gh issue create --label task-request）へ切替（ADR 0027 §3。TASK-19 旧 AC「別 task」分の実体）
- (d) **skill 更新**: 起票動作に言及する skill（lathe-loop 等）の記述を issue 投函に更新。**指示空間は監査役起草**

## 受け入れ（ADR 0029 §3）
- repo だけ読める新セッションが AGENTS.md から起票の正しい経路に到達できる（AGENTS.md → loops.md / runbook の参照チェーン）
- plan-loop / meta が backlog task create を直接呼ぶ経路が残っていない

---
intake: issue #91 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
mechanical 分（監査役 authoring）を PR #109 で着地: (a) AGENTS.md の起票記述を intake（gh issue --label task-request）へ + loops.md ポインタ / (c-meta) runbook §3 更新 / (b) .github/ISSUE_TEMPLATE/task-request.md。(d) skill 更新は lathe-loop に起票言及なしで moot。
【PdM 判断待ちで温存】(c)-plan-loop の ISSUE_CREATE 切替: plan-loop 終端の再定義 + inner-loop.test.mjs の 36 契約点の再設計を伴う loop 設計判断（自律実装から除外）。本 task の残作業はこの 1 点のみ。
<!-- SECTION:NOTES:END -->
