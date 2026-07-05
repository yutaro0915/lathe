---
id: TASK-34
title: 'ADR 0030 ⑦: 実験 loop — rubric/skill 改訂の比較実験を実行し評価・採否判断まで行う'
status: To Do
assignee: []
created_date: '2026-07-05 05:46'
labels: []
dependencies: []
priority: medium
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
rubric/skill 改訂に検証プロトコルが無く、効果を予想と照合できない（ADR 0030 背景 8）。

## 方針（ADR 0030 §6＋追記 D）
- 専用の実験 loop を新設: 入力 = 改訂案＋事前宣言の予想差分＋対象 task 集合
- 同一 task 集合で改訂前後を走らせ、結果を評価し、採否判断まで loop が行う（終端 = 採否判断の記録。採用時の改訂 landing はゲート経由）
- loops.md に実験 loop の行を追加（TASK-31 の loops.md 改訂と調整）
- 粒度規準（ADR 0030 §5）が前提条件のため、着手は TASK-29/33 の後が望ましい

## 検証
- 実 rubric 改訂 1 件で、予想差分の宣言→前後実験→評価→採否記録の一巡が回ること

---
intake: issue #129 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
