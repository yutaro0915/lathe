---
id: TASK-14
title: manifest 契約の整流 — 深い単一インターフェース + Unit/Manifest typedef + checkJs
status: To Do
assignee: []
created_date: '2026-07-04 15:56'
labels:
  - phase-2
  - rewire
  - needs-approval
dependencies:
  - TASK-13
references:
  - adr/0025-task-substrate-backlog-md.md
  - design/plan-format.md
priority: high
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ADR 0025 の drift（issue: フィールド名で unit が書かれる）の根治。opus 監査の結論＝主因は API 非対称（buildManifest の opt-in extra.unit）。PdM 指示: 薄い糊層をやめ、深い単一インターフェース（unit を渡せば path も中身も内部導出して書く1入口）に集約する。契約は Unit/Manifest typedef として PLAN の deliverable にし（plan-format §4 初適用）、tsc checkJs で機械固定。ingest 側の虚偽コメントも訂正。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 manifest 書き出しが単一入口に集約され、manifestPathFor/buildManifest の非対称と opt-in extra.unit が廃止される
- [ ] #2 実走で生成された task manifest が unit:{kind,id} を持ち issue: キーを含まない（実 artifact 照合）
- [ ] #3 Unit/Manifest typedef が plan の契約セクションに deliverable として明記され PdM 承認を経る
- [ ] #4 当該 scripts ファイルが tsc checkJs で clean（型ゲートの土台）
- [ ] #5 ingest の乖離コメント（run-manifests.ts:121-126）訂正・既存 issue-/plan- manifest の分類退行なし
<!-- AC:END -->
