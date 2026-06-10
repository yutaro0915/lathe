---
title: 観測ループ ingest 設計ノート（#2 hook payload）
type: design-note
status: in-progress
updated: 2026-06-09
---

# 観測ループ ingest 設計（#2）

このノートの全判断は下の「設計判断プロトコル」に従う。プロトコルを破った結果が
2026-06-09 の二分法事故（後述）。判断の土台は「確定事実」節の一次情報のみ。推測で上書きしない。

## 設計判断プロトコル（厳守）

1. **prior art 先行**: 枠組み・選択肢を出す前に、必ず「同じことを既存実装
   （Langfuse / OpenLLMetry / 既存の Codex・Claude 観測ツール）はどう実現しているか」を
   一次調査する。**調査 → 枠組み**の順。逆をやらない。
2. **existence-proof チェック**: 「Xは無い/できない」を前提に設計を分岐させる前に、
   「現に X をやっている実装」を探す。1件でも動いていれば前提は棄却。
   **動いている実装 ＝ その機構が存在することの証明**。
3. **subagent は実装網羅型で問う**: 「Xはあるか（Yes/No）」と自分の仮説に閉じて聞かない。
   「この機能を既存実装はどう実装しているか」を、選択肢を渡さず開いて調べさせる。
4. 推測で枠組みを出さない。確定した一次情報だけを土台にする。

### なぜこのプロトコルがあるか（2026-06-09 の事故）

Codex の取り込みを設計する際、Langfuse 等の既存実装を調べる前に
「Claude=push / Codex=scan（Codex は session 終了 push が無いから）」という二分法を
推測で立てた。誤り。**Langfuse が現に Codex を観測できている ＝ 取り込み機構は存在する**、
という存在証明を無視していた。一次調査の結果、両 agent とも Stop hook が transcript path を
渡し、Langfuse はそれを使っていた。二分法は無効だった。「存在しない」を出発点にした推論が
根本原因。一次調査を「自分の仮説の検証」に閉じ、「既存実装はどうやっているか」を問わなかった
ことが引き金。

## 確定事実（一次情報・裏取り済み。推測で上書きしない）

### Claude Code の hook
- session 系 event: SessionStart / SessionEnd / Stop / SubagentStop / PreCompact 等。
- command hook は **JSON を stdin** で受ける。共通: `session_id` / `transcript_path` / `cwd` / `hook_event_name`。
- **Stop**: + `stop_hook_active` / `last_assistant_message`（v2.1.145+ で `background_tasks` / `session_crons`）。matcher 非対応。
- **SessionEnd**: + `reason`（clear / resume / logout / prompt_input_exit / bypass_permissions_disabled / other）。
  **default timeout 1.5 秒**、ブロック不可（cleanup のみ）。
- **SessionStart**: + `source`（startup / resume / clear / compact） + `model`。
- settings.json: `hooks.<Event>[].matcher` + `.hooks[]{ type:"command", command, timeout }`。
  書込先 `~/.claude/settings.json` | `.claude/settings.json` | `.claude/settings.local.json`。`${CLAUDE_PROJECT_DIR}` 等。
- 出典: https://code.claude.com/docs/en/hooks （`/hooks.md` raw 版も）

### Codex CLI の取り込み機構
- **notify**（`~/.codex/config.toml`、user-level のみ）: `agent-turn-complete` **のみ**発火。
  payload は **argv 末尾に JSON 1個**（stdin でない）。フィールド: `type` / `thread-id` / `turn-id` / `cwd` /
  `input-messages` / `last-assistant-message`。**transcript path は来ない**。
- **lifecycle hooks**: SessionStart / Stop / UserPromptSubmit / PreToolUse / PostToolUse / PermissionRequest / Compact。
  **SessionEnd 相当は無い**（要望 issue #20603）。command hook は **stdin に JSON**、
  `session_id` / `transcript_path` / `cwd` / `hook_event_name` / `model`、turn 系 `turn_id`。
  **Stop hook が stdin で rollout transcript の path を渡す**（Langfuse plugin が使う経路）。
- **rollout ログ**: `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{uuid}.jsonl`。各行 `type` 付き JSON:
  `session_meta`（source of truth, id / cwd / cli_version 等） / `turn_context` /
  `response_item`（`function_call` / `function_call_output` を `call_id` でリンク） / `event_msg`（`token_count`）。
- **OTel export**: `[otel]` に exporter / trace_exporter / metrics_exporter。conversation id + model を含むが
  entry point で欠落（`codex exec`=metrics 無し / `mcp-server`=全無し）。user-level config のみ。
- 出典: https://developers.openai.com/codex/hooks , /config-advanced , /config-reference ;
  rollout 解析: https://dev.to/milkoor/reverse-engineering-codex-cli-rollout-traces-3b9b ;
  SessionEnd 不在: https://github.com/openai/codex/issues/20603

### 既存実装の取り込み方式
- **Langfuse 本体**: 完全 push（OTLP traces のみ / SDK / legacy ingestion）。pull/scan の口は無い。
  session は `session_id`（属性 `langfuse.session.id`）を **push 側が付与**して trace をまとめる。
- **Langfuse の Claude 連携**: 「Claude **Agent SDK**」向け（OpenInference instrumentation）。
  **Claude Code CLI 本体を hook で観測する公式手段は無い**。
- **Langfuse の Codex plugin**: **Codex Stop hook（毎ターン）→ stdin で rollout path 受領 →
  plugin が rollout JSONL を読み再構成 → Langfuse TS SDK で push**。
  ＝ hook トリガ + scan の **ハイブリッド / client 読み（下記 Y）**。Node 22+ / Codex 0.128+、fail-open。
  `<rollout>.langfuse` sidecar で再送防止。
- **hook 不使用の self-host ツール**（codex-trace / codeburn / codex-observ / codex-logs）:
  **rollout-*.jsonl をローカルで直読**（polling / tail / ingest）。＝ サーバ（ローカル）読み（下記 X）の実証。
- 出典: https://langfuse.com/integrations/other/codex , https://langfuse.com/integrations/native/opentelemetry ,
  https://langfuse.com/docs/observability/features/sessions ;
  https://github.com/PixelPaw-Labs/codex-trace , https://github.com/getagentseal/codeburn ,
  https://github.com/0xSMW/codex-observ , https://github.com/wondercoms/codex-logs

## 設計の含意と現在の論点

- **両 agent を対称に扱える**: どちらも Stop hook が stdin で transcript/rollout の path を渡す。
  push/scan の二分法は不要。pure scan（polling）は hook を仕込めない既存ツールの妥協で、
  Lathe は `lathe-client init` で hook を自動設定する方針なので非該当。
- **transcript を誰が読むか（現在の分岐）**:
  - **(X) 薄い hook + サーバ読み**（ADR 0001）: hook は path を送るだけ、サーバが transcript を読み解析。
    codex-trace 等の self-host ツールが実証。
  - **(Y) 厚い client 読み**（Langfuse 方式）: hook/plugin が client 側で読んで構造化し push。
    Langfuse がこれを採るのは **SaaS でサーバがユーザーのマシンを読めない制約**ゆえ。
  - Lathe は self-host（ADR 0004）なので **(X) が成立**。Langfuse の client 制約（Node 22+ 等）を負わない。
- **次の論点（未決）**: (X) 確定後、(1) payload フィールド集合（path + 最小ポインタ: project_id / agent 種別 /
  event / session_id / cwd 等）、(2) 発火 event（Stop / SessionEnd）、(3) project_id の解決・運搬（ADR 0002）。
