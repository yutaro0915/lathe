---
id: 21
title: finding 深掘り（analysis）+ backlog 本実装（prototype lock-in を main 品質へ）
status: in-progress
assignee: codex (/goal loop)
depends_on: [14, 17]
estimated: large
workflow: loop
audit: A   # finding データモデル界面 + analyst 出力 + migration
bound: 40 turns / 4h
---

## What

3 ラウンドの画面 prototype で lock-in した「finding 深掘り + backlog」を **main 品質**で実装する。
正本: [ADR 0008](../adr/0008-finding-depth-and-backlog.md) / design/phase2-finding-depth-and-backlog.md
（イテレーション1-3 の結論）。**UI は branch `design/findings-iter2`（commit 23c4de5）に既に収束済み**なので、
その UI を土台に promote しつつ、prototype で手抜きした部分（analyst 自動生成・正式 migration・テスト）を
本物にする。

### 実装範囲
1. **migration（schema.sql、冪等）**: `findings.analysis JSONB` + `findings.backlog_status TEXT
   CHECK (backlog_status IN ('open','addressed','dismissed'))`。既存 DB 向け `ALTER ... ADD COLUMN
   IF NOT EXISTS` + fresh 用 CREATE 内定義（ADR 0008）。durable 層（full ingest で保持）。
2. **analyst 深掘り出力（核心・新規ロジック）**: `apps/web/scripts/analyst-engine.ts` を拡張し、
   finding 生成時に `analysis{cause_hypothesis, agent_intent, impact}` を **session 文脈
   （evidence・前後 turn・USER ASKED）から grounded に生成**。埋まらない項は null（捏造禁止）。
   - prototype の analysis は手書きだった。本実装は analyst（llm 経路 `claude -p` / hybrid）が**自動生成**する。
   - **品質ゲート（重要）**: known-incident smoke を拡張し、生成 analysis が (a) 非 null 率が妥当 (b) generic
     でない（finding 固有語・evidence の実コマンド/パスに言及）ことを機械チェック。generic 作文は不合格。
3. **backlog API + verdict 接続**: `POST /api/findings/[id]/backlog`（actor 付き、accepted のみ許可）、
   verdict route で accept→`open` / reject・undo→null。iter2 の実装を promote。
4. **UI promote（iter2/iter3 = design/findings-iter2 から）**: 3 パネル（上ヘッダ固定 / list / 分析+verdict+
   backlog 非スクロール / evidence 独立スクロール）/ 分析 1 ブロック（neutral 地）/ tab = Triage・Backlog・All
   （件数つき）/ status 1 セル集約 / evidence 高さ中身追従 / ヘッダ 2 段 / Dismiss tooltip / dual-operability
   プレースホルダ。session viewer 内 Findings タブも同コンポーネントで（SESSION ヘッダ抑制、IA 原則）。
5. **既存 finding の analysis backfill**: 実 finding #110-114 に analyst を再実行して analysis を生成
   （共有 DB ではなく、検証は scratch schema。最終 backfill は full ingest 経由 or 明示スクリプト）。

## 受け入れ条件（すべて機械検証。UI は実ブラウザ+スクショ必須）

| # | 条件 | 検証 |
|---|---|---|
| 1 | migration 冪等 | fresh + 既存 DB 両方で ALTER 適用、再実行で壊れない。scratch schema で検証 |
| 2 | analyst が analysis 生成 | analyst 実行 → 新 finding に analysis 3 項（grounded、null 許容）。known-incident smoke で非 generic を機械チェック |
| 3 | backlog 遷移 | accept→open / API で open→addressed→dismissed、actor 付き、accepted のみ許可。新 e2e |
| 4 | UI（3 パネル・tab・高さ追従） | 新 e2e: Triage/Backlog/All 件数 / 分析 1 ブロック / evidence 短出力が短く / verdict 非透過（絶対位置アサート、原則8）/ ヘッダ 2 段。**実ブラウザ + スクショで検証**（hook 強制） |
| 5 | dual-operability | backlog/verdict は actor 付き同一 API（人間と将来 agent 共用）。discuss/deepen プレースホルダ |
| 6 | 回帰なし | build / e2e 全件 / coverage GREEN（E2E_PORT 指定）。Undo バナー残存バグも同梱で修正 |
| 7 | 実データ | #110-114 に analysis が付与され 3 パネルで表示されることを実 DB で確認 |

## Out of scope（ADR 0008 / ROADMAP P2 境界）

- ハーネス自動適用・改修案文面の自動生成（P5）。analysis は現象説明まで。
- chat/agent 本体（P2.5）。プレースホルダのみ。
- 採否ストリームによる analyst precision 自動測定（採否が溜まってから別途）。

## Loop 運用

- 作業ブランチ: `loop/21-finding-depth`（**`design/findings-iter2`（23c4de5）から分岐**して UI を継承 → main を
  merge して最新化 → prototype の provisional 部分を本物化）。worktree `/tmp/lathe-depth`。
- 専用 scratch / 専用 DB で検証（共有 lathe を汚さない）。e2e は `E2E_PORT` 指定（hook が build/dev 衝突を守る）。
- UI 検証は実ブラウザ + スクショ（design/audit-protocol.md 原則 8、main では verify hook が効く）。
- commit prefix `[21]`。
