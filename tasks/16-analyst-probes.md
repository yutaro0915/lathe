---
id: 16
title: analyst 3 系統 probe 基盤 + 既知インシデント replay（smoke gate）
status: todo
assignee: codex (/goal loop)
depends_on: [14, 15]
estimated: large
workflow: loop
audit: B
bound: 40 turns / 4h
---

## What

[ADR 0007](../adr/0007-finding-model-and-phase2-gate.md) §3。analyst candidate 3 系統と
選抜の足場を実装する。**analyst の出力は現象レベルの finding（ハーネス語彙に踏み込まない）**。

1. **runner 基盤**: `pnpm -F web analyst -- --candidate <name> [--session <id>] [--turn <session>:<n>]` で
   候補を DB に対して実行し、`submit_finding` 経由（MCP or 同関数）で findings を登録。
   findings.analyst に候補名を刻む。**指定スコープ検出**（design §6.3）: --session / --turn で
   明示対象に絞れること。提出は 1 実行 × 1 candidate あたり **20 件上限・confidence 降順**、
   重複 key = (analyst, kind, 主 evidence 座標)
2. **トリガー**: rules-v1 のみ notify 完了後に自動実行（当該 session 限定スコープ・同期 ingest を
   ブロックしない）。llm-v1 / hybrid-v1 は手動 CLI のみ
3. **候補 3 系統**:
   - `rules-v1`: ヒューリスティック（最低 4 検出器 = kind 4 種に対応。例: 同一コマンド 3 連続 exit≠0 → failure_loop / 帰属無し hunk 比率 → unattributed_diff / G9 anomaly 連携 → excess_cost / 危険コマンドパターン → risky_action）
   - `llm-v1`: session bundle を LLM に読ませ JSON schema で finding を出させる。実行基盤は
     **CLI provider 抽象**（`claude -p --output-format json --json-schema` 優先 = subscription 完結、
     env API key を fallback。design §6.4）。CLI も key も無ければ skip + ログ（CI/オフラインで壊れない）。
     **内部実行のタグ付け**（design §6.5）: analyst の自己 transcript が ingest された場合に
     識別できる印を残す
   - `hybrid-v1`: rules で候補箇所を絞り、その文脈だけ LLM に仕立てさせる
4. **既知インシデント replay（smoke gate）**: `spec/known-incidents.json` に seed 正解集合を作る
   （本 repo の実例から最低 5 件: 例 = cost 3 倍過大 / e2e データ依存 flake / `.next` 破損 /
   tasks/13 の fixture 自己充足 / 二分法事故。各件 = 該当 session の特定条件 + 期待 kind）。
   `pnpm -F web analyst:smoke` が 3 候補を seed に対して走らせ **recall を報告**する。
   **閾値で fail させない**（N が小さく最適化対象にしない — 動作確認のみ。ADR 0007）

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | 3 候補が実 DB で完走し findings を登録 | 各候補の実行 exit 0、findings に analyst 名別の行が存在 |
| 2 | 現象レベル制約 | 全 finding の body にハーネスファイルへの編集指示が含まれないことを smoke が検査（簡易 lint: 「CLAUDE.md を」「AGENTS.md に」等の編集文型を警告） |
| 3 | evidence 必須 | 全 finding が finding_evidence ≥ 1 を持つ |
| 4 | replay smoke | `analyst:smoke` が候補別 recall 表を出力し exit 0（recall 値は報告のみ） |
| 5 | 冪等性 | 同一候補の再実行で findings が重複しない |
| 6 | llm-v1 の skip 経路 | CLI も API key も無い環境で exit 0 + skip ログ |
| 6b | 指定スコープ | --session 指定で当該 session のみ、--turn 指定で当該 turn のみが対象になる（他 session に findings が増えない） |
| 6c | notify 連動 | notify 後に rules-v1 が当該 session に自動実行され、ingest 応答をブロックしない |
| 7 | 回帰なし | ingest / coverage / e2e / build 全 GREEN |

## Out of scope

- 採否 UI（tasks/17）/ 候補のチューニング（運用フェーズ）/ 自動定期実行

## Loop 運用

- 作業ブランチ: `loop/16-analyst-probes`（tasks/15 merge 後の main から分岐）
- LLM 呼び出しは 1 箇所に抽象化（モデル/プロンプト差し替えが候補追加で済むように）
