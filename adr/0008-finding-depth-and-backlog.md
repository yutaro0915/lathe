# ADR 0008: finding の深掘り（analysis）と backlog_status をデータモデルに追加

- status: accepted
- date: 2026-06-13
- 関連: ROADMAP Phase 2 開始ゲート界面契約 #2（finding データモデル）/ design/phase2-finding-depth-and-backlog.md / design/agent-human-dual-operability.md

## 背景

Phase 2 dogfood で「finding が浅い（パターン照合止まり）」「Accept しても何になるか分からない」という
ペインが出た。3 ラウンドの画面 prototype（別ポート比較）で価値と提示方法を実証し lock-in した
（design/phase2-finding-depth-and-backlog.md イテレーション1-3）。finding データモデルは P2 開始ゲートで
「後から変えると高くつく界面契約」と位置づけたため、ADR として確定する。

## 決定

`findings` に nullable 2 カラムを追加する（冪等 ALTER、durable 層）:

1. **`analysis` JSONB**（深掘り）:
   ```
   { cause_hypothesis: string|null, agent_intent: string|null, impact: string|null }
   ```
   - analyst（rules/llm/hybrid）が finding 生成時に session 文脈（transcript・前後 turn・USER ASKED）
     から埋める。埋められない項は null（捏造しない）。
   - **スコープ境界**: 現象の説明まで。ハーネスの直し方（harness vocabulary）には踏み込まない
     （ADR 0005 §3 / ROADMAP P2 境界と整合）。
   - 後から再生成しない（再生成 = analyst 再実行 = 新 finding）。

2. **`backlog_status` TEXT**（Accept の行き先）: `'open' | 'addressed' | 'dismissed' | null`、
   CHECK 制約つき。
   - Accept 時に `open` をセット、reject/undo で null。`addressed`/`dismissed` はユーザー手遷移
     （ハーネス適用自体は P2 では Lathe の外）。
   - backlog = accepted かつ open。`open` な accepted finding が P3 fixture の入力候補（P2 完了定義の具体化）。

## dual-operability（founding 原則、ADR 不可侵制約）

- backlog 状態遷移・採否は **人間ボタンと将来の agent tool が叩く同一 HTTP API**（actor 付き）。
  `POST /api/findings/[id]/backlog`、verdict route で accept→open。
- finding に「discuss/deepen with agent」プレースホルダ（P2.5 chat/agent 接続余地）。hard-couple しない。

## UI（lock-in した形）

- finding 詳細 = **3 パネル**（上ヘッダ固定 / ①list / ②分析+verdict+backlog（不透明・非スクロール）/
  ③evidence（独立スクロール））。sticky verdict は使わない（透け・上下往復の回避）。
- 分析は **1 グループブロック**（Intent→Why→Impact、青を抑えた neutral 地）。
- tab = **Triage(pending) / Backlog(accepted+open) / All**（各件数つき）。「Decided」単独タブは作らない。
- status は 1 セルに集約（"ACCEPTED · OPEN" 等）。evidence の command/output は中身の高さに追従。
- backlog UI は Findings 軸内フィルタ（グローバルバーに新軸を足さない、IA 原則）。

## 却下した代替

- evidence-interleaved（分析を証拠に分散）: 分かりにくい（prototype V3 却下）。分析はまとめる。
- backlog を独立グローバル軸に: nav 過剰。Findings 内フィルタで足りる。
- Pending/Decided/Backlog の 3 タブ分割: 区別の価値が不明瞭。Triage/Backlog/All に簡素化。

## 影響

- migration: 既存 DB へ冪等 ALTER（fresh は CREATE 内）。full ingest は durable 層を保持。
- analyst-engine: 出力に analysis 3 項を追加（grounded、null 許容）。smoke で非 generic を確認。
- MCP/agent: 将来 backlog 操作・analysis 参照を tool 化できる契約を維持。
