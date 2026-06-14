# ADR 0009: agent を一級モジュール（core）にし、analyst をその consumer にする

- status: accepted
- date: 2026-06-14
- 関連: ADR 0005（harness artifact model）/ ROADMAP 論点 #16（chat/agent = P2.5）/ 論点 #19（dual-operability）/ design/agent-human-dual-operability.md / 0008（finding depth）

## 背景・動機（2026-06-14 ユーザー）

Phase 2 で analyst を「深掘り analysis を出す」よう強化する過程で、auto-analyst の性能を追うと結局
「アプリにエージェントの概念を入れる（provider をどう使うか / context をどう読ませるか / harness を
どうするか）」必要が出る、と判明。**agent は遅かれ早かれ必ず導入する**（P2.5 chat、将来は agent に
分析・検知・タスク受領・管理まで＝ dual-operability）。ならば analyst を孤立させて後で再結合する
のでなく、**先に汎用 agent core を作り、analyst をその部分集合（consumer）にする**のが正しい。
analyst を完全分離すると「追加で分析させる」連携がおかしくなる、というユーザー指摘が根拠。

## 調査（disciplled-research、一次情報）

provider 非依存 + MCP + 対話/非対話 を同一 core で出している実在実装 7 件（Vercel AI SDK / LangGraph.js /
OpenAI Agents SDK / Mastra / Pydantic AI / 公式 MCP TS SDK / Anthropic "Building Effective Agents"）を
網羅。**全実装に共通の 6 層**が現れた（命名差のみ）。出典は status.md / 調査ログ参照。

## 決定: agent core の 6 層（lathe = 薄い自前 TS、`packages/agent/`）

1. **Provider adapter** — `LanguageModel` interface（`generate(messages, tools, opts)` / `stream(...)`）。
   provider 固有を実装クラスに封じる。初期実装: `claude-cli`（`claude -p`）/ `anthropic-api`（fetch）/
   `codex-exec`（`codex exec`）。*根拠: Vercel `LanguageModelV3` / LangGraph `BaseChatModel` / OpenAI `Model`。*
2. **Tool registry** — 統一 `Tool` 型 `{name, description, inputSchema(Zod), execute(input, ctx)}`。
   **ローカル tool と MCP tool を同じ型に正規化**。*根拠: Vercel `tool()`↔`mcpClient.tools()` 等、全実装が変換 adapter を 1 枚持つ。*
3. **MCP client 層** — 公式 MCP TS SDK の `Client` + transport（stdio/http/sse）。`listTools()`→registry 充填、
   `callTool()`→execute。**LLM と完全分離 = 特定 host（Claude Code）専用化しない担保点**。lathe 自身の
   MCP server（5 tools）にも他 server にも繋げる。
4. **Agent loop（core, 唯一の正本ロジック）** — provider + registry を受け、`messages` を積みながら
   「LLM 出力 →(tool_call 有無で分岐)→ execute → 結果を append → 再 LLM」。停止 = tool_call 無し final
   message **or** maxSteps 上限。*根拠: 5 framework すべて同型。*
5. **Context assembly** — `instructions` + `messages` + **ホストが集めた `deps`（Postgres 行: SessionBundle /
   findings / evidence 等）** を loop 入力に組む。Postgres は **この層の deps 経由でのみ** core に入る。
   *根拠: Pydantic `deps_type`/`RunContext` = 「agent が欲しいデータをホストが集めて渡す」の直接先行例。*
6. **Consumer（薄い）** — 同一 core を 2 エントリで露出: `run()`=非対話（単発・任意で構造化 output schema）/
   `stream()`=対話。*根拠: Vercel generateText/streamText, OpenAI Non/Stream, Pydantic run_sync/run_stream。*

## analyst = consumer（部分集合）

- analyst の **検出ルール**（rules-v1）は「候補 finding を集める前処理」として残す（provider 非依存）。
- analyst の **LLM 深掘り** = `run(core, { instructions: analyst prompt, tools: lathe MCP read tools,
  deps: 収集した SessionBundle/evidence, output: findingAnalysisSchema(Zod) })` の 1 呼び出しに置換。
- これで「追加で分析」も同じ core の別 run/stream で自然に繋がる。loop/21 の深掘り（cause/intent/impact +
  env-vs-product）は consumer の output schema として core 上に乗る。

## 「ビジネスロジック」の所在（ユーザーの問いへの答え）

agent core はドメイン非依存。**lathe 固有のビジネスロジックは 3 箇所に集約**:
(a) 層2 tool の `execute`（lathe MCP 5 tools + ローカル tool）/ (b) 層5 で lathe が集めて渡す deps /
(c) consumer の output schema + instructions。「agent が X したい → ホストがデータ収集 → tool 公開」は
この 3 つで表現される。

## 対話/非対話

同一 loop core、2 エントリ。**非対話 = analyst**（run、構造化出力）。**対話 = P2.5 chat**（stream）。
両者がエンジンを共有することが本 ADR の主眼（dual-operability の技術的土台）。

## 再利用 / 解体（現コード）

- そのまま素地: MCP 5 tools（packages/mcp）= 層3 供給源 / `db.ts` getSessionBundle = 層5 deps 収集 /
  rules 検出 / dedup（submitDrafts）。
- 撤去済み chat-agent（git 履歴、commit acbfdad）が層1+2+3 の原型（buildAgentLaunchConfig /
  invokeLatheMcpTool / allowed-tools）を持つ → 復活・一般化。
- 解体: analyst-engine.ts の provider 選別（selectLlmProvider/callLlmJson → 層1）、prompt schema 直書き
  （→ consumer 引数）、生成ループ（→ 層4 core）。

## スコープ / 順序（2026-06-14 ユーザー決定）

agent core を先に実装 → analyst を consumer に載せ替え → loop/21 の深掘りを core 上で整合 → まとめて merge。
loop/21 branch（finding 深掘り機能、commit 6d39aff）はそれまで温存。

## スコープ外

- 完全な agent operability（agent が分析・検知・タスク受領・管理まで）は最終フェーズ（論点 #19）。
  本 ADR は「土台の core + analyst consumer + P2.5 chat が乗れる形」まで。
- harness の自動適用（P5）。
