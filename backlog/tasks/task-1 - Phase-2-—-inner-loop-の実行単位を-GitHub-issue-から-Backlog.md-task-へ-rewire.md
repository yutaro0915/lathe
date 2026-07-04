---
id: TASK-1
title: Phase 2 — inner-loop の実行単位を GitHub issue から Backlog.md task へ rewire
status: To Do
assignee: []
created_date: '2026-07-04 10:21'
updated_date: '2026-07-04 10:46'
labels:
  - phase-2
  - rewire
milestone: m-0
dependencies: []
references:
  - adr/0025-task-substrate-backlog-md.md
  - adr/0023-derived-runs-from-manifest.md
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
開発ループの実行単位を GitHub issue 番号から Backlog.md task へ付け替える。task 側に scope/AC/plan/deps が1枚で載り、issue body・plan manifest・.lathe/wbs/tasks.json に散っている情報を単一正本に集約する。観測コア（session/run ingest, apps/web）は不変で、変わるのは実行単位の identity のみ。as-is/to-be と gap list の詳細は ADR 0025 §4。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 inner-loop が backlog task を単位に PLAN→MERGE を完走する
- [ ] #2 manifest が unit を {kind,id} で表現し ingest の loop_kind が task run を正しく分類（既存 issue-N manifest は退行しない）
- [ ] #3 merge.mjs の終端が task status=Done を立てる
- [ ] #4 inner-queue が task の depends_on/sequence で並列順序を解決する
- [ ] #5 観測コア不変の証明: task 1本を実走させ ingest まで確認
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. inner-loop.mjs — unit id 取得元/worktree 命名/manifest 書き出し
2. inner-queue.mjs — 依存源を task frontmatter depends_on へ
3. merge.mjs — 終端で task status=Done
4. inner-loop-prompts/backends — prompt の "issue" 参照
5. manifest の unit keying を {kind,id} へ（filename 結合を脱結合）
6. ingest loop_kind 追随 (apps/web, ADR 0023 companion)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PLAN 承認 2026-07-04。3子タスクへ分解（TASK-1.1 基盤+ingest / 1.2 impl-loop driver+終端Done / 1.3 inner-queue+plan-loop+open issue移送）。依存 1.1→1.2→1.3。PdM 決定: (1) plan-loop 今回含む (2) 走行中以外の open issue は task へ移送・走行中のみ旧フローで drain (3) DB は run_key 識別・schema 列追加なし (4) driver は node_modules/.bin/backlog 直呼び・status=Done は worktree 内で立て squash に載せる・Touches は当面 description 行を継続 parse。実装は inner-loop（別セッション）で 1.1 から。注: frontmatter 依存キーは dependencies。
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 該当 rubric GREEN (node rubrics/run.mjs)
- [ ] #2 review+verify receipt を添付し merge.mjs 経由で着地
<!-- DOD:END -->
