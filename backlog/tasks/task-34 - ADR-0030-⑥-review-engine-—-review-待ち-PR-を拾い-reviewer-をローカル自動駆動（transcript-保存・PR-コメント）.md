---
id: TASK-34
title: >-
  ADR 0030 ⑥: review engine — review 待ち PR を拾い reviewer をローカル自動駆動（transcript
  保存・PR コメント）
status: To Do
assignee: []
created_date: '2026-07-05 06:32'
labels: []
dependencies: []
priority: medium
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
PR review を gh 上のホスト実行にすると transcript が lathe の観測面に載らない。task loop 内蔵の review（TASK-16 方式）は task 由来 PR にしか効かず、outer の ADR PR 等が review を受けない。

## 方針（ADR 0030 追記 B）
- 新規コンポーネント engine: review 待ちの open PR を拾い、reviewer をローカルで自動駆動する（transcript は lathe に ingest される）
- レビュー結果は PR 上のコメントとして残す（TASK-16 で導入済みのコメント形式を流用）
- task loop から独立し、全 PR に適用（起票元を問わない）
- auto-merge の arm 順序（reviewer PASS 後）との整合は TASK-33（task loop 縮退）と調整
- 注: escalation（ADR 0030 §4）は設計未了のため、本 engine への CI RED/CHANGES 拾いの追加は討議後の別 task とする（本 task は review 駆動のみ）

## 検証
- 実 PR で engine が review を駆動し、PR コメントが残り、transcript が ingest されること
- task 由来でない PR（例: 監査役の ADR PR）にも review が付くこと

---
intake: issue #128 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
