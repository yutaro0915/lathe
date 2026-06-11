---
title: G9 — コスト異常検知（baseline 設計ドラフト）
status: accepted（2026-06-11 ユーザー決定: baseline = ハイブリッド案 H / cost 検証を実装前に実施 → tasks/11・12）
created: 2026-06-11
updated: 2026-06-11
---

# G9 コスト異常検知 設計ドラフト

S1-3「コスト監視: Overview で異常を検知」を閉じる。表示面の界面は
[g8-explorer-ui.md](./g8-explorer-ui.md) §6 で定義済み（session 一覧行の anomaly chip +
sessbar の「最も高い turn へ」「エラー turn へ」ジャンプ chip）。
本ドラフトは検知ロジック（baseline）を実データ分析（2026-06-11、341 sessions / cost 非 NULL 310）
に基づき確定させる。

## 実データの構造（分析サマリ）

- **heavy-tail + 二峰性**: 全体 median $3.17 / mean $71.62。実態は codex（median $1.20）と
  claude-code（median $50.11）の二峰。単一 global 閾値は構造的に成立しない
- **`project` 列は全 341 行が単一値 "LLMWiki"**（dogfood 初期の実態）。「project 別 baseline」は
  現状 global と同値 → **グループ軸は当面 runner（将来 runner × project）**
- **cost NULL が 31 件**（codex-auto-review 25 / synthetic 4 / claude-code 2）→ baseline 計算から
  除外し、判定は fallback 絶対閾値のみ
- **turn 単位 cost は直接取れない**: token_usage は assistant_message のみ・claude-code 限定
  （109/111 sessions、codex 0/230）。token 按分の推定では最大 turn が session 全体の
  median 20% / p90 73% を占める — 「最も高い turn へ」chip は claude-code では有効、
  codex では cost ベース表示不能（duration / event 数ベースの代替が必要）

## baseline 候補の比較（シミュレーション結果）

| 案 | 閾値 | flag 数 / 率 | 問題 |
|---|---|---|---|
| 1 倍率 | runner median × 5 | 57 / 18% | codex 側で $6 台の正常 session を 41 件誤検知（安いグループ × 倍率のノイズ） |
| 2 percentile | runner p95 | 17 / 5.5% | p95 自体が外れ値に吊られ $300〜1,200 の真の異常を見逃す。cold start に弱い |
| 3 絶対閾値 | $30〜100 | 77〜40 / 25〜13% | claude-code は $30 超が 58% で常時発火（アラート疲れ） |
| **H ハイブリッド（推奨）** | **cost > max(runner median × 5, $50)**。グループ n<10 or cost NULL は $50 のみ | **28 / 9.0%**（codex 12 / cc 16） | 倍率ノイズを floor が消し、絶対閾値の常時発火を倍率側が抑える |

## 前提課題（G9 実装前に推奨）

**cost 算出の検証**: claude-code の session cost（max $1,591）に過大の疑い（cache 割引の
扱い等）。異常検知は cost の正しさが前提なので、実装前に pricing ロジックを 1 回監査するのが
安全（小タスク。`db/pricing.json` × 実 transcript の突き合わせ）。

## ユーザー判断待ち（2 点）

1. **baseline**: 案 H（推奨）/ 案 1 / 案 2 / 案 3 / その他指定
2. **前提検証**: cost 算出監査を G9 実装前に挟むか（推奨）、G9 と並行か、省略か

## 実装スケッチ（baseline 確定後に task 化、audit: B 想定）

- 検知は **query 時計算**（ingest 時のフラグ書き込みはしない。閾値変更で過去が変わるのは
  異常検知として正しい挙動。MATERIALIZED 化は性能が問題になってから）
- `lib/db.ts` に anomaly 判定 query（runner 別 median を window で計算 + floor）
- UI: g8 §6 の界面どおり（一覧行 chip `▲ cost`、sessbar ジャンプ chip。
  デザインは ui-design-language.md の規律 = ニュートラル + エラー系のみ特権色）
- 「最も高い turn へ」chip: claude-code = token 按分 cost、codex = duration ベース fallback
- 受け入れ条件: 検知件数が本ドラフトのシミュレーション値と一致する fixture 的検証 +
  chip 表示/ジャンプの E2E + 既存 e2e 全件 GREEN
