---
id: 12
title: G9 コスト異常検知（hybrid baseline + anomaly chip + ジャンプ導線）
status: in-progress
assignee: codex (/goal loop)
depends_on: [11]   # cost 検証が GREEN になってから
estimated: medium
workflow: loop
audit: B
bound: 20 turns / 2h
---

## What

[design/g9-cost-anomaly.md](../design/g9-cost-anomaly.md)（baseline は 2026-06-11 ユーザー決定）の実装。
S1-3 を閉じる。

1. **検知（query 時計算、ingest 時のフラグ書き込みはしない）**:
   `cost > max(グループ median × 5, $50)`。グループ軸 = runner（将来 runner × project）。
   グループ n < 10 または cost NULL のグループは絶対閾値 $50 のみに fallback
2. **UI**（[g8-explorer-ui.md](../design/g8-explorer-ui.md) §6 の界面 + [ui-design-language.md](../design/ui-design-language.md) の規律）:
   - session 一覧行 + Overview に anomaly chip（`▲ cost`。ニュートラル基調で警告系のみ特権色）
   - sessbar に「最も高い turn へ」「エラー turn へ」ジャンプ chip
3. **「最も高い turn」の算出**: claude-code = token 按分の推定 cost、codex = duration ベース fallback
   （transcript_events に cost 列がないため。design 文書 §4 の分析参照）

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | 検知の正しさ | 新 E2E: tasks/10 の `getTurnExpectations` と同型の independent oracle — テスト側で DB から baseline 式を直接計算した anomaly 集合と、UI の chip 表示集合が一致 |
| 2 | fallback の正しさ | 新 E2E or 検証スクリプト: n<10 グループ・cost NULL session が $50 ルールで判定されている |
| 3 | ジャンプ導線 | 新 E2E: 「最も高い turn へ」click で該当 turn が展開・スクロールされ active になる（claude-code session）。codex session では duration ベースで同動作 |
| 4 | 閾値の一元化 | baseline 式（×5 / $50 / n<10）が 1 箇所の定数/設定に集約され、UI とテストが同じ定義を参照 |
| 5 | 回帰なし | `pnpm -F web build` / e2e 全件 / coverage GREEN |

## Out of scope

- 通知・アラート配信（表示のみ）/ baseline の UI からの変更機能 / project 軸（単一値のため）

## Loop 運用

- 作業ブランチ: `loop/12-g9-cost-anomaly`（**tasks/11 merge 後の main** から分岐）
- UI は ui-design-language.md の規律に従う（mono+tabular・ニュートラル + 特権色のみ）
