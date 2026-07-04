---
id: TASK-2
title: 'feat(meta): meta-loop driver — SCOPE→GROUND→DIAGNOSE→REPORT の read-only 状態機械'
status: To Do
assignee: []
created_date: '2026-07-04 10:56'
labels:
  - meta-loop
dependencies: []
references:
  - adr/0024-meta-loop.md
  - design/outer-loop-family.md
modified_files:
  - scripts/meta-loop.mjs
  - scripts/meta-loop-prompts.mjs
  - scripts/meta-loop.test.mjs
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ADR 0024（accepted）の gap#5。meta-audit を driver 駆動の staged pipeline に工学化する。inner-loop.mjs の機構（状態機械・stage 権限・VERDICT 契約・manifest・backend 抽象）を流用するが read-only（MERGE 段なし・書き込みは manifest/report のみ）。設計正本 design/outer-loop-family.md。

状態機械 SCOPE→GROUND→DIAGNOSE→REPORT（各 stage は headless agent＋VERDICT トークン・verdict-guard hook 下）:
- SCOPE: SCOPED|ESCALATE（起動理由＋プロファイルから監査計画確定・問いは 1 run 1 つ）
- GROUND: GROUNDED|ESCALATE（lathe MCP 段階開示・重い/並列は fan-out）
- DIAGNOSE: DIAGNOSED|ESCALATE（result-classification skill で §結果分類 13 行に写像・行13/境界不明は ESCALATE）
- REPORT: REPORTED（finding＋判断記録を .lathe/meta/<run>/ に）

read-only 機械強制: agent cwd は使い捨て worktree・Write/Edit 不許可・manifest と report は driver が main 側（.lathe/runs/meta-*.json / .lathe/meta/）へ書く（agent は書かない＝inner の receipt を driver が刻む方式と同型）。
プロファイル読込: scripts/meta-profiles/<id>.json（run-health / gate-effectiveness は作成済み）を SCOPE が読む。
manifest: .lathe/runs/meta-<profile>-<通番>.json（loop_kind=meta・inner と同形式）。
fan-out 契約（ADR 0024 §4）: 渡す{対象,問い,接地面,深さ上限}／返す{問題,根拠座標,仮説,確信度}。逸脱形式は破棄し 1 回再依頼。X1（inner ネスト禁止）との区別を prompt に明記。
backend=claude 既定（lathe MCP 接地が必須）。headless claude が repo の .mcp.json から lathe MCP を掴めるかを実装時に検証し、掴めなければ報告して ADR 追記（設計判断要なら ESCALATE）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 4 stage の遷移・VERDICT 契約・プロファイル読込・manifest 生成・read-only 強制（agent が repo/DB/gh に書かない）がテストで固定される
- [ ] #2 dry-run で監査計画→接地→分類→report の遷移が表示される
- [ ] #3 node --test scripts/meta-loop.test.mjs が pass・pnpm preflight --fast --changed が通る
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
inner-loop.mjs の状態機械/stage 権限/manifest 機構を流用して meta-loop.mjs を新設。result-classification skill を DIAGNOSE の agent へ注入。lathe MCP 接地の可否検証を最初に行い、不可なら ESCALATE。
<!-- SECTION:PLAN:END -->
