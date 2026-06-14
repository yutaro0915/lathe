---
id: 22
title: agent core モジュール（packages/agent、6 層）— provider 非依存 + MCP + 対話/非対話
status: in-progress
assignee: codex (/goal loop)
depends_on: [14, 15]
estimated: large
workflow: loop
audit: A   # provider 抽象 + MCP tool surface + 界面契約
bound: 40 turns / 4h
---

## What

[ADR 0009](../adr/0009-agent-as-core-module.md) の agent core を `packages/agent/` に新規実装する。
**この task は core のみ**（analyst の載せ替えは tasks/23）。ただし core が analyst と P2.5 chat の
両 consumer を載せられる形であることを、最小の consumer サンプルで実証する。

## 実装（6 層、純 TS、web から独立。Postgres は層5 deps 経由でのみ）

1. **provider adapter** `src/provider.ts`: `LanguageModel` interface（`generate(messages, tools, opts): Promise<AssistantTurn>` / `stream(...): AsyncIterable<...>`）。実装 3 つ:
   - `claude-cli`（`claude -p` を spawn、stdin prompt、stream-json）
   - `anthropic-api`（`fetch` /v1/messages、model は引数で注入。env 直読みしない）
   - `codex-exec`（`codex exec --json`）
   provider 固有（フラグ・認証・パース）は実装クラス内に封じる。撤去済み chat-agent（git commit acbfdad の `apps/web/lib/chat-agent.ts`）と現 analyst-engine.ts:540-724 の provider ロジックを参考に抽出・一般化。
2. **tool registry** `src/tool.ts`: 統一 `Tool` 型 `{name, description, inputSchema: ZodType, execute(input, ctx): Promise<unknown>}`。ローカル tool 登録 + MCP tool を同型に正規化する adapter。
3. **MCP client** `src/mcp-client.ts`: 公式 `@modelcontextprotocol/sdk` の `Client` + transport（stdio 必須、http/sse は interface だけ用意でよい）。`listTools()`→registry 充填、`callTool()`→`execute`。**特定 host 非依存**（Claude Code 前提のハードコード禁止）。lathe 自身の MCP server（packages/mcp の 5 tools）に stdio で接続できることを実証。
4. **agent loop** `src/loop.ts`: provider + registry + context を受け、messages を積みつつ「LLM 出力→tool_call 分岐→execute→append→再 LLM」。停止 = tool_call 無し final message **or** maxSteps（既定 20、引数で可変）。tool 実行は registry 経由。
5. **context assembly** `src/context.ts`: `{ instructions, messages, deps }` を loop 入力に組む型と builder。deps は呼び出し側（ホスト）が渡す任意データ（lathe では SessionBundle 等。core は中身を知らない）。
6. **consumer entrypoints** `src/index.ts`: `runAgent(config): Promise<RunResult>`（非対話。`config.output?: ZodType` 指定時は最終ターンを構造化 object に。tool loop は回す）/ `streamAgent(config): AsyncIterable<AgentEvent>`（対話。text/tool_call/tool_result/done を逐次）。

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | provider 非依存 | 3 provider が同一 `LanguageModel` interface を満たす。fake provider を注入した loop が動く unit テスト（実 LLM 不要で決定的に） |
| 2 | MCP host 中立 | mcp-client が packages/mcp の 5 tools に stdio 接続し listTools/callTool 実行（fixture / 実 server で）。Claude Code 固有のハードコードが無い（grep） |
| 3 | tool 正規化 | ローカル tool と MCP tool が同じ registry 型で loop から呼べる（fake で決定的に） |
| 4 | loop 停止 | final message で停止 / maxSteps 超過で停止（fake provider で両ケース） |
| 5 | 対話/非対話 | `runAgent`（構造化 output schema 指定で型付き object 返却）/ `streamAgent`（逐次イベント）が同一 core で動く（fake provider）|
| 6 | consumer サンプル | 「analyst-lite」と「chat-lite」の最小 consumer 2 本が core を使って動く例（fake provider、実 analyst 載せ替えは tasks/23） |
| 7 | 回帰なし | 既存 web の build / e2e / coverage に影響なし（packages/agent 追加のみ、web 本体は未改変）。`pnpm -F @lathe/agent build` GREEN、agent の unit テスト GREEN |

## Out of scope（tasks/23 以降）

- 既存 analyst の載せ替え（tasks/23）。loop/21 深掘りの core 上整合（tasks/23）。
- P2.5 chat 本体 UI（後続）。本 task は chat-lite サンプルまで。
- harness 自動適用（P5）。

## Loop 運用

- 作業ブランチ: `loop/22-agent-core`（main から分岐、worktree `/tmp/lathe-agentcore`）。
- core は実 LLM 無しで unit テスト可能に（fake provider 必須）= ゲートが決定的。
- 検証で Postgres を使う場合は専用 scratch（共有 lathe を汚さない）。commit prefix `[22]`。
- 監査は Tier A（界面契約 = provider interface / MCP surface / tool 型）。**監査は Codex xhigh**（audit-protocol 原則 7）。
