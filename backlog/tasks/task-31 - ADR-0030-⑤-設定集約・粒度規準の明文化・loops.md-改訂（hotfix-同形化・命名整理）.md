---
id: TASK-31
title: 'ADR 0030 ⑤: 設定集約・粒度規準の明文化・loops.md 改訂（hotfix 同形化・命名整理）'
status: To Do
assignee: []
created_date: '2026-07-05 05:01'
updated_date: '2026-07-05 06:37'
labels: []
dependencies: []
priority: medium
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
MAX_CYCLES 等が driver にハードコード。task 粒度規準が未明文化で比較実験の前提を欠く。loops.md の命名（inner=family 名兼用）と hotfix 緊急路（定型成果物なし）が旧設計のまま。

## 方針（ADR 0030 §5・§7–9）
- driver の運用パラメータを単一設定ファイルに集約
- plan-format.md scale rules に粒度規準「人間が数分（理想 1 分）で完全に理解できる範囲」を分割規準として明文化
- loops.md 改訂: 個別 loop 名 = task loop／plan-task／感知（meta）に整理、harness-hotfix を issue→intake→task→PR+CI の同形（優先 label＋PdM 同期承認のみ差分）に改訂
- rubric 改訂 = 比較実験（§6）の受け入れ条件を rubric 管理 loop の定義に追記
- 依存: ADR 0030 ①〜③ の着地後（文書が実態を先行しないように）

## 検証
- ハードコード値の grep がゼロ（設定ファイル参照のみ）
- loops.md／plan-format.md の改訂が ADR 0030 の決定と一対一対応していること

---
intake: issue #118 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ADR 0030 追記 E: loops.md 改訂に「裁定 loop の起動条件 = escalation label task の到着」を含めること（従来の .lathe/runs/*.escalation.md 監視は廃止）。追記 D の実験 loop 行の追加も本 task の loops.md 改訂と統合。

ADR 0031（2026-07-05 PdM 裁定）: 着手禁止。task 正本は GitHub Issues へ移行（Backlog.md 廃止）。本 task の内容は移行後に issue 上で再定義する（ADR 0030 の決定は不変・substrate のみ変更）。
<!-- SECTION:NOTES:END -->
