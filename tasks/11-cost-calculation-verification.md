---
id: 11
title: cost 算出の検証と修正（claude-code 過大疑いの解消 — G9 の前提）
status: done
assignee: codex (/goal loop)
depends_on: []
estimated: medium
workflow: loop
audit: A   # ingest 正しさ（cost の意味論）に触れるため
bound: 20 turns / 2h
---

## What

G9（コスト異常検知）の前提として、session cost の算出を検証し、誤りがあれば修正する。
2026-06-11 のデータ分析で claude-code の session cost に過大の疑い（max $1,591、
cache 割引の扱い等）が指摘された（[design/g9-cost-anomaly.md](../design/g9-cost-anomaly.md)）。

## Input

- cost 算出: `apps/web/scripts/ingest/` 配下（provider 解析 + `db/pricing.json`、LiteLLM 由来）
- 既知の仕様（PROTOTYPE.md）: cache_read は cost に含む（課金対象 4 分類すべて計上）が
  tokens 表示には含めない。session 合計はメイン transcript のみ（サブエージェント別掲）
- 疑いの根拠: claude-code median $50 / max $1,591 は subscription 実感に対し高い

## Output / 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | `pnpm -F web verify:cost` スクリプト新設 | 上位 5 高額 session + 無作為 10 session について、raw transcript から単価表で再計算した cost と DB 値の一致（許容誤差 0.5%）を exit code で返す |
| 2 | 単価表の照合 | `db/pricing.json` の claude / gpt 系主要モデル単価を公式公開価格と突き合わせ、差異を `docs/cost-semantics.md` に記録（出典 URL 付き。**変更する場合は理由を必ず記載**） |
| 3 | 判定の文書化 | `docs/cost-semantics.md` に「何を cost に含むか」（4 分類・cache の扱い・サブエージェント除外）と検証結論（正しかった / 修正した + before/after）を記載 |
| 4 | 修正した場合の再 ingest | cost ロジック変更時は `pnpm -F web ingest` 後に verify:cost が GREEN |
| 5 | 回帰なし | `pnpm -F web build` / `pnpm -F web e2e` 全件 / `pnpm -F web coverage` GREEN |

## Out of scope

- G9 の検知ロジック・UI（tasks/12）
- サブエージェント cost の session 合計への合算（既知の将来拡張）

## Loop 運用

- 作業ブランチ: `loop/11-cost-verification`（main から分岐）
- 注意: 「正しかった」という結論も合格（検証が目的。無理に変更を作らない）。
  受け入れ条件コマンドの改変による充足は不可
