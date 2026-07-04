---
id: TASK-18
title: 'docs(runbook): outer 運用知識の repo 移設 — memory 廃止の後始末（ADR 0026 §4）'
status: To Do
assignee: []
created_date: '2026-07-04 16:08'
labels: []
milestone: m-18
dependencies: []
priority: medium
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
監査役が起草。セッション外 memory（~/.claude 配下）にしか無い outer 運用知識を repo 内へ移設し、以後 memory 参照なしで運用可能にする。対象: escalation 対応の型（manifest 手術・resume・裁定記録）/ worktree 検証規律（GREEN 誤報と main 再検証）/ ingest no-wipe 規律 / PdM 起票規約（新規機能・アーキ判断は平文説明→承認→起票、自明バグは即時報告で可）。置き場は design/runbooks/ 等（loops.md と整合させる）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 escalation 対応手順・検証規律・起票規約が repo 内文書として存在する
- [ ] #2 移設後の文書だけで outer 運用が完結する（memory への参照が残っていない）
<!-- AC:END -->
