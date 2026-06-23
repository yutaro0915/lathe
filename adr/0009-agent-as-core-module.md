# ADR 0009: agent 駆動は ACP client（B）— lathe は agent loop を作らない

- status: accepted（2026-06-14 改訂、A→B 転換）
- date: 2026-06-14
- 関連: ROADMAP 論点 #16（chat/agent = P2.5）/ #19（dual-operability）/ design/agent-human-dual-operability.md / 0008（finding depth）
- supersedes: 本 ADR 初版（2026-06-14 午前の「agent core 6 層・lathe が loop 所有」= A）

## 改訂の経緯（A→B、なぜ初版が誤りだったか）

初版（同日午前）は「provider 非依存の agent core を 6 層で自前実装し、**lathe が agent loop を所有**する」= **Architecture A**。これは誤り。

- A の調査は「provider 非依存 + LLM I/O + MCP + **agent loop** をどう実装するか」と問うた。この問い自体が「lathe が loop を作る」を前提し、調べた対象（Vercel AI SDK / LangGraph / OpenAI Agents SDK / Mastra / Pydantic AI = 生 API の上に自前 loop を組むフレームワーク）が全部 A に収束した。disciplined-research の「枠組み先行で調査を検証に使う」事故。
- 実装（tasks/22, packages/agent）は `LanguageModel.generate()`=1 ターン生成 + `runLoop` で tool 駆動・停止判定を **lathe が再実装** = Claude Code / Codex / Cursor が既に内蔵する loop の **車輪の再発明**だった。
- ユーザー指摘（2026-06-14）: 「provider を選んだらそのセッションを呼び出し、tool と文脈を与え、こちらは I/O 制御だけ」「生 API で agent を組む必要は今ない。必要でも『API で agent を組む→B に接続』で済む。A の価値はゼロ」。正しい。

## 決定: lathe は ACP client（Architecture B）

lathe は **agent loop を実装しない**。ユーザーが選んだ既存 agent ランタイム（Claude Code / OpenAI Codex / Cursor 等）を**セッションとして駆動**し、tool（MCP）と文脈を渡し、**入出力と承認だけを仲介**する。loop・tool 呼び出し・思考・停止は agent の中で回る。

共通 IF は **ACP（Agent Client Protocol、Zed 発、JSON-RPC 2.0 over stdio、40+ agent 対応、Apache）**。lathe は ACP の **client（editor 役）**になる。

```
lathe (ACP client)                     既存 agent ランタイム（ACP adapter 経由）
  │  initialize                        claude-agent-acp / codex-acp /
  │  session/new {mcpServers[], cwd} → cursor `agent acp` / gemini …
  │  session/prompt(入力)            →  [agent 内部で loop: LLM↔tool↔stop]
  │  ← session/update(出力ストリーム)        ↑ lathe の MCP server に接続して tool 実行
  │  ← session/request_permission     →  {selected, optionId}  ← dual-operability UI/agent
  │  session/cancel(中断)
```

### 各責務の所在
- **セッション起動 / I/O**: lathe が ACP client として `session/new` → `session/prompt` → `session/update`（stream）→ `session/cancel`。
- **tool**: lathe の既存 **MCP server（`packages/mcp`、tasks/22 以前から存在）** を `session/new` の `mcpServers[]` で渡す。**agent 側が MCP client になって tool を呼ぶ**。lathe は MCP server を公開するだけ。
- **context**: instructions / cwd / additionalDirectories を `session/new` + prompt の ContentBlocks で渡す。
- **permission**: `session/request_permission`（agent→lathe）を **dual-operability UI**（人 or agent が承認）に直結。承認の一級フック。
- **observation**: `session/update` ストリームを lathe の観測層に流す。
- **auth**: **lathe は持たない**。ACP adapter が起動する CLI が、そのマシンで既にログイン済みの資格情報（ユーザーの Claude/ChatGPT/Cursor サブスク）をそのまま使う。= Zed の external agents と同じ。lathe が API キーを持たずに「ユーザーが普段使う当の agent」を呼べる。

### provider 切替
**adapter バイナリの差し替えだけ**（claude-agent-acp / codex-acp / cursor `agent acp` / gemini `--experimental-acp` …）。lathe の client コードは不変。

## analyst / chat は ACP セッションの consumer
- **analyst（非対話）**: 1 回の `session/prompt`（system=分析 instructions、tools=lathe MCP、構造化出力期待）→ 結果を読む。
- **chat（対話、P2.5）**: 多ターンの `session/prompt` ⇄ `session/update`。
- 両方が **同じ ACP client core** を共有。「追加で分析」も同じセッションへの次の prompt で自然に繋がる（ユーザー要件）。

## skill の扱い（前 ADR からの継続論点）
skill = provider 非依存の playbook。lathe 側で「session に渡す instructions/context」を組み立てる層に置き、playbook が複数になった時点で SKILL.md 規約で外出し（provider のビルトイン skill 機能には依存しない）。ACP の context は ContentBlocks 経由なので、skill 本文も lathe が prompt/context として注入する。

## 破棄 / 再利用（tasks/22 packages/agent の精算）
- **破棄**: `packages/agent/src/loop.ts`（自前 loop）/ `provider.ts`（`LanguageModel.generate` per-turn 抽象）/ `mcp-client.ts`（`NeutralMcpClient`＝lathe を MCP **client** にする層。B では agent が MCP client）/ `tool.ts` registry / `index.ts`・`context.ts` の loop wrapper。= packages/agent ほぼ全体（~1200 行、埋没コスト）。
- **再利用**: `packages/mcp`（MCP server、tasks/22 以前から存在）= `session/new` で渡す対象。context 組み立ての発想。

## provider 非依存性と逃げ道（折衷）
- **既定 = ACP**（唯一の provider 非依存標準）。
- **逃げ道**: ACP で表現しきれない高粒度機能が要る provider だけ、公式 agent SDK（Claude Agent SDK の `canUseTool`、Codex SDK、Managed Agents のサーバ側永続化等）を **同じ lathe 内部 IF の裏に直 wrap** して併設。default は触らない。

## 却下した代替
- **A（自前 loop・6 層 core、本 ADR 初版）**: 車輪の再発明、価値ゼロ。却下。
- **provider ごと公式 SDK 直 wrap のみ（案B）**: provider 非依存でなく、正規化層を lathe が保守し続ける。default 不採用、逃げ道としてのみ保持。
- **Managed Agents のみ**: Claude 専用・サーバ側 loop で、ユーザーのローカル サブスク CLI を使えない。lathe の「実際に使う agent を観測」と不整合。却下（将来 Claude をサーバ実行したい時の選択肢には残す）。

## トレードオフ / 留保（正直に）
1. ACP の **remote(HTTP/WS) transport は仕様上 WIP** → 当面 **local subprocess 前提**。単一ユーザー local dogfood + サブスク認証がローカルにある以上、むしろ必然で問題なし。
2. **Codex の ACP adapter は Zed/community 製**（OpenAI 公式でない）= 成熟度差。逃げ道で Codex SDK 直 wrap に切替可能。
3. ACP の context は ContentBlocks 経由 → Claude の preset system prompt 等 **provider 固有機能は使えない可能性**（per-call 承認は `session/request_permission` で表現できるので失われない）。
4. **サブスクのヘッドレス駆動の利用規約**面は未確認（機構上は `claude -p`/Agent SDK と同経路で動く）。必要なら別途確認。

## スコープ
- 本 ADR = 「agent 駆動の基盤」= ACP client + 既存 MCP server を渡す配線 + context 注入 + permission ブリッジ + observation。
- スコープ外: 自前 loop の構築（しない）/ 生 API agent（必要時に B 互換として接続）/ 完全な agent operability（最終フェーズ、#19）/ harness 自動適用（P5）。

## 一次情報（出典）
- ACP: agentclientprotocol.com/protocol/schema（`session/new` の `mcpServers[]` / `session/prompt` / `session/update` / `session/request_permission` / `session/cancel`）, /get-started/agents（対応一覧）, github.com/agentclientprotocol/agent-client-protocol（SDK: Rust/TS/Py/Java/Kotlin）, github.com/zed-industries/{claude-agent-acp, codex-acp}, github.com/openclaw/acpx（client 駆動の存在証明）
- Claude Agent SDK: code.claude.com/docs/en/agent-sdk/typescript（逃げ道用）
- Anthropic Managed Agents: anthropics/skills `claude-api/shared/managed-agents-overview.md`
- OpenAI Codex SDK: developers.openai.com/codex/sdk / Cursor CLI: cursor.com/docs/cli/acp

## 追補（2026-06-23）: agent config home（~/.lathe）＋ 共有 ACP harness

本 ADR の「ACP client + 既存 MCP server を渡す配線」を、chat と analyst で**重複させず単一化**する具体決定（旧 ADR 0010 を本 ADR に統合）。

- **config home**: lathe agent は host 子プロセスとして動き、runtime config home = `CLAUDE_CONFIG_DIR=~/.lathe`（可動状態・認証は `$HOME` に置き git 外）。版管理の正本は `agent/`（prompt + skills + settings skeleton）。`scripts/setup-lathe-agent.sh` が `~/.lathe` を `agent/` への symlink で構成。
- **harness 集約**: ACP 駆動配線（adapter 選択 / MCP server 構築 / permission / Claude settings）を 1 つの共有 module（`apps/web/lib/lathe-agent-harness.ts`）に集約。`CLAUDE_CONFIG_DIR` と `settingSources:['user']` を単一注入 → user tier が個人 `~/.claude` でなく `~/.lathe` に解決（project tier は含めない＝repo の `.claude/` を避ける）。これで chat の `settingSources:[]` band-aid 撤去・analyst の個人 skill 漏れ + `options.tools` MCP 抑止バグを同時解消。permission 解析は `toolCall.title`（claude-agent-acp が MCP tool 名に使う）を含む。
- **permission**: chat/analyst とも deny-by-default。chat=read-only lathe tools のみ、analyst=`mcp__lathe__submit_finding` のみ許可。
- **compose 内実行への切替トリガー**（それまでは host 子プロセス維持）: (1) Phase 3 の未信頼コード実行で OS レベル sandbox が要るとき / (2) multi-user・hosted deploy で per-user auth が要るとき（この時は filesystem-local transcript 読みが崩れるので保留中の jsonl-push 変種も必要）。
- ADR 0004（host 実行分離）と本 ADR の ACP local subprocess / local credential を適用するもので、いずれにも矛盾しない。
