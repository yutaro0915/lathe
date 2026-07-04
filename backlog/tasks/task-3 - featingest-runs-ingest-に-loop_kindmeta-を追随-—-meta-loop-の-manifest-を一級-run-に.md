---
id: TASK-3
title: >-
  feat(ingest): runs ingest に loop_kind=meta を追随 — meta-loop の manifest を一級 run
  に
status: Done
assignee: []
created_date: '2026-07-04 10:57'
updated_date: '2026-07-04 16:24'
labels:
  - meta-loop
milestone: m-18
dependencies:
  - TASK-2
references:
  - adr/0024-meta-loop.md
modified_files:
  - apps/web/scripts/ingest/run-manifests.ts
  - apps/web/scripts/ingest/run-manifests.test.ts
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ADR 0024 gap#3。meta-loop driver（TASK-2）は manifest を .lathe/runs/meta-<profile>-<通番>.json（loop_kind=meta）に書く。この manifest を runs ingest（ADR 0023）が拾えるようにする小粒改修。これで meta-loop 自身の run が lathe に載り、run-health プロファイルが meta-loop 自体を監査対象にできる（自己適用・dogfooding 入口）。

実装: run-manifests.ts の run_key / loop_kind 判定に meta-* プレフィックスを追加（現状 issue-* / plan-* を判定している箇所と同型。TASK-1.1 が unit{kind,id} 化するならその枠に 'meta' を足す形で整合させる）。meta manifest の stage 集合（SCOPE/GROUND/DIAGNOSE/REPORT）が run_stages スキーマに載ることを確認（stage 名 enum 制約があれば緩める）。既存 issue-*/plan-* の ingest は不変。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 .lathe/runs/meta-*.json が runs/run_stages に loop_kind=meta として ingest される
- [ ] #2 既存の issue/plan manifest の ingest に回帰が無い
- [ ] #3 verify:incremental が GREEN
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
TASK-1.1（manifest unit keying）と整合させる。独立実装可だが、AC 検証には TASK-2 の meta manifest が要るため依存を張る。
<!-- SECTION:PLAN:END -->
