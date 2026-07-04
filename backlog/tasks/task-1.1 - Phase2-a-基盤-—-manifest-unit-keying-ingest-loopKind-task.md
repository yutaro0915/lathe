---
id: TASK-1.1
title: Phase2-a 基盤 — manifest unit keying + ingest loopKind 'task'
status: To Do
assignee: []
created_date: '2026-07-04 10:45'
labels:
  - phase-2
  - rewire
  - foundation
dependencies: []
references:
  - adr/0023-derived-runs-from-manifest.md
  - adr/0025-task-substrate-backlog-md.md
parent_task_id: TASK-1
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
実行単位の土台。manifest を run_key=task-<slug>.json に、ingest の loopKind に 'task' 分岐を足す。ここだけで観測コア不変（退行ゼロ）を先に固定する。ADR 0025 §4 / ADR 0023。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 buildManifest が run_key=task-<slug>.json に unit{kind,id} を書く
- [ ] #2 ingest の loopKind に 'task' 分岐追加。issue-/plan- 分岐は無改変で退行なし
- [ ] #3 task run は source_issue_number=NULL・run_key で識別（schema.sql 無変更）
- [ ] #4 run-manifests.test に task ケース追加＋既存 issue/plan 回帰を固定
- [ ] #5 scratch DB で task-N.json を ingest し loop_kind='task' 確認・既存 issue-N は 'issue' 維持
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
buildManifest/manifestPathFor(inner-loop.mjs) → loopKind/sourceIssueNumber(apps/web/scripts/ingest/run-manifests.ts) → fixture .lathe/runs/task-N.json → run-manifests.test.ts
<!-- SECTION:PLAN:END -->
