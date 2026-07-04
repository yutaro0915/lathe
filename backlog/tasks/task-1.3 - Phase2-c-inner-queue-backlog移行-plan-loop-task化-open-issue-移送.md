---
id: TASK-1.3
title: Phase2-c inner-queue backlog移行 + plan-loop task化 + open issue 移送
status: Done
assignee: []
created_date: '2026-07-04 10:45'
updated_date: '2026-07-04 14:56'
labels:
  - phase-2
  - rewire
  - queue
milestone: m-18
dependencies:
  - TASK-1.2
references:
  - adr/0025-task-substrate-backlog-md.md
parent_task_id: TASK-1
priority: medium
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
並列 dispatch を backlog へ、plan-loop の gh issue create を backlog task create へ、走行中以外の open GitHub issue を task へ移送（走行中は旧フローで drain）。ADR 0025 §4。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 inner-queue が backlog sequence/dependencies で実行順・並列群を解決（自前 DAG 削減）
- [ ] #2 Touches 衝突回避を保持・running 検出 regex を inner-task- へ
- [ ] #3 plan-loop の ISSUE_CREATE を gh issue create → backlog task create へ
- [ ] #4 走行中でない open GitHub issue を backlog task へ移送（走行中は旧フローで drain）
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
fetchQueueIssues/依存解決/running/spawn(inner-queue.mjs) → plan-loop ISSUE_CREATE(inner-loop.mjs) → 既存 open issue の task 移送 → inner-queue.test.mjs 更新
<!-- SECTION:PLAN:END -->
