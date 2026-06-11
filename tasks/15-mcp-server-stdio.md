---
id: 15
title: MCP server（stdio）— transcript query + finding 提出の界面
status: todo
assignee: codex (/goal loop)
depends_on: [14]
estimated: medium
workflow: loop
audit: A   # 外部 agent との界面契約（tool surface）
bound: 20 turns / 2h
---

## What

[ADR 0007](../adr/0007-finding-model-and-phase2-gate.md) §2。`packages/mcp/`（新 package）に
stdio MCP server を実装し、analyst（外部 agent）が lathe DB を query / finding 提出できるようにする。

tool surface（読み 4 + 書き 1、これが界面契約）:
- `list_sessions(filter?)` — id/title/runner/model/cost/harness_version の一覧（ページング）
- `get_session_bundle(session_id)` — 既存 `lib/db.ts` の bundle を再利用
- `query_findings(filter?)` — kind / verdict 状態 / session でフィルタ
- `get_evidence_context(subject_kind, subject_id)` — evidence 参照先の実体（event 本文・hunk 等）
- `submit_finding(finding)` — kind 4 種 + evidence 必須のバリデーション付き insert

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | stdio で起動し MCP handshake が通る | 検証スクリプト: JSON-RPC で initialize → tools/list が 5 tools を返す |
| 2 | 読み 4 tools の正しさ | 検証スクリプト: 実 DB に対し各 tool を呼び、DB 直クエリと結果一致（independent oracle） |
| 3 | submit_finding | evidence 無し / kind 不正 を拒否し、正常系は findings + evidence が insert される。再送で重複しない（冪等 key） |
| 4 | ビジネスロジックの置き場 | route/tool handler 直書きにせず `apps/web/lib` or shared の関数を呼ぶ（notify と同じ継ぎ目方針） |
| 5 | 回帰なし | ingest / coverage / e2e / build 全 GREEN |

## Out of scope

- HTTP/SSE transport（サービス化時）/ 認証 / analyst 本体

## Loop 運用

- 作業ブランチ: `loop/15-mcp-server`（tasks/14 merge 後の main から分岐）
- MCP SDK は公式 TypeScript SDK を使用（自前実装しない）
