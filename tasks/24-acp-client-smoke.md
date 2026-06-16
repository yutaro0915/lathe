---
id: 24
title: ACP client 疎通スモーク + packages/agent 撤去（B の存在証明）
status: in-progress
assignee: codex (/goal loop)
depends_on: [15]
estimated: medium
workflow: loop
audit: A   # 界面契約 + 存在証明スモーク
bound: 40 turns
---

## What

[ADR 0009](../adr/0009-agent-as-core-module.md)（B = lathe は ACP client）の第一歩。
lathe を **ACP client** として実装し、既存 agent ランタイム（まず Claude Code = `claude-agent-acp` adapter）を
セッション駆動して **lathe の MCP server を渡し・入力を送り・出力と承認を仲介できる**ことを、実 agent で実証する。
**A（自前 loop）の `packages/agent` は本 task で撤去**する。

## 前提の不確実性（このスモークで潰すのが主目的）
1. `claude-agent-acp` が `session/new` の `mcpServers[]` を honor し、**lathe の MCP tool を実際に呼ぶ**か
2. `session/request_permission`（agent→client）の実挙動（tool 実行前に承認を問うか）
3. **ユーザーのサブスク認証で headless 駆動できる**か（lathe は API キーを持たない）
→ いずれも「動いた/動かない」を**正直に報告**。動かなければ blocker として記録し、偽 GREEN にしない。

## 実装

1. **`packages/agent` を撤去**（loop.ts/provider.ts/mcp-client.ts/tool.ts/context.ts/index.ts/types.ts/agent.test.ts、package.json 含む）。
   web 本体・他 package への依存が無いことを確認してから削除。pnpm-workspace から外す。
2. **新規 `packages/acp-client/`**（server-side Node、TS）:
   - ACP の TS SDK を使う（正しい npm package を解決すること。候補: `@agentclientprotocol/*`／repo `github.com/agentclientprotocol/agent-client-protocol` の TS SDK。実在を確認し、無ければ JSON-RPC over stdio を最小自前実装）。
   - API（薄い）: `runSession({ adapter, mcpServers, cwd, prompt, onUpdate, onPermission }): Promise<SessionResult>`。
     - `adapter`: 起動する ACP agent の command/args（claude-agent-acp）。
     - `mcpServers`: `session/new` に渡す MCP server 定義（**lathe の `packages/mcp` を stdio で spawn する command**）。
     - `onUpdate(update)`: `session/update` 通知を受けるコールバック（観測層に流す前提）。
     - `onPermission(req) -> {outcome:'selected', optionId}`: `session/request_permission` を判定（スモークでは auto-allow、将来 dual-operability UI）。
   - lifecycle: `initialize → session/new → session/prompt → (update/permission stream) → done`、`session/cancel` も実装。
3. **fake ACP agent**（テスト用、実 LLM 不要で決定的）: stdio JSON-RPC を喋るモックを 1 個用意し、client の lifecycle・permission 往復・update ハンドリングを unit テストで決定的に検証。
4. **実スモーク**（実 `claude-agent-acp`、要 claude ログイン）: lathe の MCP server を渡し、`list_sessions` のような **lathe MCP tool を必ず使わせる prompt**を送り、(a) update がストリームされる (b) **agent が lathe の MCP tool を実呼びした証跡** (c) permission 往復が動く (d) サブスク認証で完了、を確認・記録。

## 受け入れ条件（機械検証 + 正直な存在証明）

| # | 条件 | 検証 |
|---|---|---|
| 1 | packages/agent 完全撤去 | `ls packages/agent` で不在、web build / e2e / coverage 影響なし（grep で参照 0）|
| 2 | ACP client lifecycle | fake agent 相手に initialize/new/prompt/update/cancel が決定的に通る unit テスト |
| 3 | permission 往復 | fake agent が request_permission を出し、client の onPermission 判定が反映される（allow/deny 両ケース）|
| 4 | MCP 受け渡し | session/new に lathe MCP server を渡せる（fake で受領を確認）|
| 5 | **実スモーク（存在証明）** | 実 claude-agent-acp + lathe MCP server で、agent が lathe MCP tool を実呼び（証跡をログ）。**動けば証跡を提示、動かなければ blocker を具体的に報告**（package 不在 / 認証不可 / mcpServers 無視 等、どれかを明記）|
| 6 | 回帰なし | `pnpm -F @lathe/acp-client build`+unit GREEN、`pnpm -F web build`/e2e/coverage GREEN（web 未改変）|

## Out of scope（tasks/25）
- analyst の載せ替え。chat（P2.5）。dual-operability UI 本体（onPermission は auto-allow スタブまで）。

## Loop 運用
- 作業ブランチ `loop/24-acp-client`（main から、worktree `/tmp/lathe-acp`）。fake agent でゲートを決定的に。
- 実スモークは要 claude ログイン環境。DB を使う検証は専用 scratch。commit prefix `[24]`。
- 監査 Tier A（界面契約 + 存在証明スモークの再現）。**監査は Codex xhigh**。
