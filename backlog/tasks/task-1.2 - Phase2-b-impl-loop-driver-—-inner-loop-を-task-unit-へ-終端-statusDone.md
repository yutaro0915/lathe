---
id: TASK-1.2
title: Phase2-b impl-loop driver — inner-loop を task unit へ + 終端 status=Done
status: To Do
assignee: []
created_date: '2026-07-04 10:45'
labels:
  - phase-2
  - rewire
  - driver
dependencies:
  - TASK-1.1
references:
  - adr/0025-task-substrate-backlog-md.md
parent_task_id: TASK-1
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
impl-loop の driver 一族を issue→task へ付け替え、backlog task 1本を PLAN→MERGE 完走させる。merge.mjs は無改変（receipt ゲート不変）。ADR 0025 §4。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 parseDriverArgs が task id を受理（--task TASK-1）
- [ ] #2 fetchTask = backlog task view --plain、worktree 命名 inner-task-<slug>
- [ ] #3 prompts/backends の 'issue' 参照を task へ（gh issue 系 allowedTools を backlog read-only へ）
- [ ] #4 merge 成功後に backlog task edit --status Done（md 直編集禁止）。merge.mjs 無改変
- [ ] #5 backlog task を1本 PLAN→MERGE 完走（観測コア不変の実証）
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
parseDriverArgs/fetchTask/worktree命名(inner-loop.mjs) → marker/worktree literal(inner-loop-prompts.mjs) → READ_ONLY tools(inner-loop-backends.mjs) → 終端 markTaskDone → inner-loop.test.mjs 更新
<!-- SECTION:PLAN:END -->
