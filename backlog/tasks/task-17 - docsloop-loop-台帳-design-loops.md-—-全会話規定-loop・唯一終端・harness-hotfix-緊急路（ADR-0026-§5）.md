---
id: TASK-17
title: >-
  docs(loop): loop 台帳 design/loops.md — 全会話=規定 loop・唯一終端・harness-hotfix 緊急路（ADR
  0026 §5）
status: To Do
assignee: []
created_date: '2026-07-04 16:08'
labels: []
milestone: m-18
dependencies: []
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
監査役が起草（外部空間）。landing は新ゲート経由。内容: (a) 全ての会話は規定された loop の一つ——outer 4 系統（前進/escalation 対応/rubric 管理/感知）+ inner + harness-hotfix の一覧と各 loop の唯一の終端（outer の終端に実装は無い）。(b) harness-hotfix loop の発動条件（gate 自体の故障）・必須要素（PdM 明示承認 + ゲート通過 + 事後 incident 記録）。(c) セッション開始時の loop 宣言手順（規範でなく観測。lathe ingest → meta-loop 監査項目）。(d) design/agent-workflow.md から重複記述を削り loops.md へリンク（単一正本）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 design/loops.md が 1 ページで全 loop・終端・緊急路・宣言手順を規定している
- [ ] #2 agent-workflow.md の重複が削られ loops.md にリンクされている
<!-- AC:END -->
