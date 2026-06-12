---
id: 18
title: agent チャット view（/chat 専用画面・CLI provider・lathe MCP 限定）
status: in-progress
assignee: codex (/goal loop)
depends_on: [14, 15]
estimated: large
workflow: loop
audit: A   # agent 実行基盤 + 道具制限（安全境界）
bound: 40 turns / 4h
---

## What

[design/phase2-finding-model.md](../design/phase2-finding-model.md) §6.4。観測データについて
agent と対話しながら分析する**専用画面**（2026-06-11 ユーザー要求: パネルでなく 1 画面）。

1. **`/chat` route（専用画面）**: 左 = thread 一覧（新規作成・タイトル自動）、中央 = 会話。
   ui-design-language.md 準拠。上部タブ列からの入口も追加
2. **実行基盤 = CLI provider 抽象**: `claude -p`（stream-json）優先 / `codex exec` 切替可。
   subscription 完結、env API key fallback。応答はストリーミング描画
3. **道具制限（安全境界 = 本 task の核心）**: チャット agent に与える tool は
   **lathe MCP 5 tools のみ**（tasks/15）。ファイル編集・bash・Web は与えない。
   コーディング agent 化させない（ROADMAP 設計境界）
4. **文脈の持ち込み**: session / finding を thread に attach でき、agent の文脈に含まれる。
   Findings 行と sessbar に「Discuss」導線
5. **finding への接続**: チャット中の agent が `submit_finding` した指摘は Findings タブに現れ、
   通常の採否フローに乗る
6. **永続化**: `chat_threads` / `chat_messages`（tasks/14 の永続層）
7. **自己観測タグ**: チャット agent の transcript が ingest された場合 internal 印（design §6.5）

## 受け入れ条件（すべて機械検証。E2E は fake provider で決定的に）

| # | 条件 | 検証 |
|---|---|---|
| 1 | 画面の基本動線 | 新 E2E: /chat で thread 作成 → 送信 → 応答が表示される（fake provider） |
| 2 | ストリーミング | 新 E2E: 応答が逐次描画される（chunk 分割 fixture） |
| 3 | **道具制限** | 検証スクリプト: agent 起動構成に許可 tool が lathe MCP 5 tools のみであることを機械検査（設定の静的検査 + 実行時に bash/file tool 呼び出しが拒否される fixture） |
| 4 | MCP 経由の観測参照 | fixture: agent が `get_session_bundle` を呼び、その内容を応答に使う経路が通る |
| 5 | attach | 新 E2E: session を attach した thread で、agent 入力に当該文脈が含まれる（fake provider の受信記録で検証） |
| 6 | finding 接続 | fixture: チャット中の submit_finding → Findings 一覧に出現し採否できる |
| 7 | 永続層 | thread/messages が full sweep 後も生存（tasks/14 の検証に統合可） |
| 8 | 実 provider smoke | `claude -p` が使える環境でのみ実行する手動 smoke スクリプト（1 往復 + tool 1 回）。無ければ skip + ログ |
| 9 | 回帰なし | e2e 全件 / build / coverage GREEN |

## Out of scope

- ハーネスの自動適用（Phase 5）/ チャットからのファイル編集・コード実行（恒久的にスコープ外）/
  マルチユーザー / チャット履歴の検索

## Loop 運用

- 作業ブランチ: `loop/18-agent-chat`（tasks/15 merge 後の main から分岐。17 と並行可）
- CLI provider は speak-loose-english の実証パターン（`-p --output-format json` 系）を参考に、
  ただしコードは本 repo で独立実装
