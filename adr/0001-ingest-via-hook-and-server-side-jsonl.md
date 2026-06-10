---
id: 0001
title: Ingest pipeline = Stop hook trigger + server-side jsonl reading
status: accepted
date: 2026-06-07
deciders: [yutaro0915, claude]
supersedes: null
---

## Context

Lathe の Phase 1 観測層は、現状 **pull 型**である(本体サーバが `~/.claude/projects/**/*.jsonl` を起動時 / 定期に scan)。これを **dogfood の各プロジェクトから明示的に link する形**へ移行するにあたり、取り込み方式を改めて決める必要があった。

事実調査(2026-06-07):

- **OpenTelemetry 経由**(`CLAUDE_CODE_ENABLE_TELEMETRY=1`)では:
  - prompt / tool I/O / thinking は**デフォルト全部 redact**
  - opt-in しても tool I/O は **60KB cap**
  - **extended-thinking は `OTEL_LOG_RAW_API_BODIES` でも明示的に redact**(=どんなフラグでも永久に取れない)
  - 出典: [Observability with OpenTelemetry — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/observability)
- **Hook payload 経由**では:
  - `PreToolUse` / `PostToolUse` / `UserPromptSubmit` は本文込みで取れる
  - `Stop` / `SessionEnd` には **transcript inline は来ない**、`transcript_path` だけ来る
  - **extended-thinking は hook payload に含まれない**
  - 出典: [Hooks reference — Claude Code Docs](https://code.claude.com/docs/en/hooks)
- **JSONL ファイルにしかない情報**:
  - extended-thinking 本文
  - 60KB cap なしの tool I/O
  - サブエージェントの parentUuid tree
  - per-message timestamps + 本文
- **Langfuse(LLM observability SaaS の本職)**は、最初 OTel direct で受けようとして失敗し、最終的に **Stop hook + transcript.jsonl パース + SDK push** に集約している。
  - 出典: [Langfuse Claude Code integration](https://langfuse.com/integrations/other/claude-code), [discussion #9242](https://github.com/orgs/langfuse/discussions/9242)

## Options

- **A. Pull 型(現状)**: 本体サーバが `~/.claude/projects/**` を直接 scan する。
- **B. Pure push 型**: hook が transcript の差分を含めて全部 POST する。
- **C. OTel 受信**: 本体サーバが OTLP endpoint を立てて Claude Code から OTel 受信。
- **D. Hook トリガー + サーバ側 jsonl 読み(hybrid)**: hook が「Stop が来た、session_id は X、transcript_path は Y、project は Z」だけ POST し、本体サーバが transcript_path を読む。サーバ停止中の取りこぼしは起動時の catch-up sweep で回収。

## Decision

**D を採用する**。

理由:

- B (pure push) は **thinking が hook payload に含まれないため永遠に取れない**。kill 時のバッファロスト等の取りこぼしも発生する。
- C (OTel) はメトリクス用途には足りるが、本文系が全部 redact / truncate されるので Lathe の目的(全細部観測)に合わない。
- A (現状 pull) は dogfood の単一 PC では動くが、**プロジェクトの identity が不明**(現状の `deriveProjectKey` は変更ファイルパスからの推測で歪む)、リアルタイム性が低い、scan 負荷がかかる。
- D は Langfuse が実証済みの方式。プロジェクト identity を hook が明示的に運ぶので推測が要らない。本体側の jsonl 読みロジックは現状を流用できる。サーバ停止中の取りこぼしは catch-up sweep(現状の pull ロジックを残す)で回収できる(=push 主・pull 補)。

## Consequences

- **各プロジェクトに `pnpm install lathe-client` を install する必要が出る**。`lathe-client init` が `.claude/settings.json` に Stop hook を登録 + 本体 URL を保存 + project identity を本体に登録する。
- **既存の pull 型 scan ロジックは catch-up として残す**(廃棄しない)。サーバが落ちている間の取りこぼしを起動時に回収する。
- **hook payload で運ぶのは識別子だけ**(`session_id` / `transcript_path` / `project_id` / `cwd` 等)。本文は本体側でファイルから読む。
- **HTTP API が必要になる**: `POST /api/ingest/notify` で hook が叩く endpoint。実装は Phase 1 リファクタ完了後の next sprint。
- **将来のマルチ PC dogfood**: 別 PC からも同じ本体に push する形なら、各 PC で lathe-client + 各 PC の transcript パス読みで対応可能(Phase 7 で再評価)。
