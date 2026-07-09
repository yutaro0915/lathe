# Cloud Session Transcript Observability — Research Findings

**Date**: 2026-07-08  
**Subject**: Feasibility of machine-readable transcript retrieval for Claude Code cloud sessions (Routines)  
**Status**: gating issue for routines adoption in lathe  

---

## Executive Summary

**判定: B — 劣化した形なら取得できる**

Cloud sessions (Routines, claude.ai/code) からのトランスクリプト取得は、**公開 API では tool-call粒度の直接取得は不可能**です。代替手段は以下の通り：

1. **OpenTelemetry export** - 事後的に metrics・logs・traces を export（tool決定、実行、cost）
2. **Session events stream API** - リアルタイム event 購読（run中のみ、過去遡不可）
3. **Session URL** - Web UI で human-readable 形式（機械解析不可）

lathe が観測（tool call 列・token・cost）を維持するには、**OpenTelemetry export に移行し、tool-level粒度を再設計**する必要があります。

---

## 調査対象・方法

### 公式ドキュメント取得

| 資料 | 取得元 | 確認項目 |
|------|--------|--------|
| Claude Code sessions | https://code.claude.com/docs/en/sessions.md | Local JSONL storage、export |
| Managed Agents Sessions | https://platform.claude.com/docs/en/managed-agents/sessions | API create、retrieve、list |
| Session Operations | https://platform.claude.com/docs/en/managed-agents/session-operations | Session data retrieval |
| Routines | https://code.claude.com/docs/en/routines.md | Cloud execution、run、transcript |
| Claude Code Monitoring | https://code.claude.com/docs/en/monitoring-usage.md | OpenTelemetry、metrics |
| Agent SDK Observability | https://code.claude.com/docs/en/agent-sdk/observability.md | Telemetry export |

---

## 主要発見

### 1. Local Sessions (CLI)

**現行 lathe 運用**:
- File location: `~/.claude/projects/<project>/<session-id>.jsonl`
- Format: plaintext JSONL
- Access: Direct file read / `/export` コマンド
- Advantage: machine-readable、complete history

出典: https://code.claude.com/docs/en/sessions.md#export-and-locate-session-data

---

### 2. Cloud Sessions API

#### 2.1 Routine /fire Endpoint

```json
POST /v1/claude_code/routines/trig_[ID]/fire
Response:
{
  "claude_code_session_id": "session_01ABC...",
  "claude_code_session_url": "https://claude.ai/code/session_01ABC..."
}
```

出典: https://code.claude.com/docs/en/routines.md#trigger-a-routine

#### 2.2 Session Retrieval

**API endpoint**: `GET /v1/sessions/{id}`

**取得可能なデータ**: 
- id、status (idle/running/terminated)
- agent、environment_id

**取得不可**: messages、tool calls、transcript

出典: https://platform.claude.com/docs/en/managed-agents/session-operations#retrieving-a-session

#### 2.3 Event Stream API

**リアルタイム subscription**: `/v1/sessions/{id}/stream`

**制限**:
- Run中のみ stream 可能
- Run終了後は history 取得不可

出典: https://platform.claude.com/docs/en/managed-agents/events-and-streaming

---

### 3. OpenTelemetry Export（代替手段）

#### 3.1 Exportable Data

| Signal | Content |
|--------|---------|
| Metrics | token count, cost, tool decisions |
| Logs | user prompt, tool result, decision, error |
| Traces (beta) | spans for interaction, LLM, tool execution |

#### 3.2 Configuration

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example.com:4318
```

出典: 
- https://code.claude.com/docs/en/monitoring-usage.md
- https://code.claude.com/docs/en/agent-sdk/observability.md

#### 3.3 Limitations

- Export は batch + interval（5-60秒）
- Tool level の span はあるが、full I/O はopt-in
- Historical retrieval は不可（export時点で完成）

---

## 対比表: Local vs Cloud

| 項目 | Local JSONL | Cloud + OTel |
|------|-----------|------------|
| 取得方法 | File read | Export to collector |
| 粒度 | Message、tool I/O | Tool span、metric |
| 完全性 | 100% | Structural only |
| Latency | Immediate | 5-60秒 batch |
| Historical retrieval | ✓ | ✗ |
| Cost tracking | ✓ | ✓ |
| Token tracking | ✓ | ✓ |

---

## 判定と推奨

### 判定: **B — 劣化した形なら取得できる**

**Lathe の観測維持戦略:**

| 現行 | 代替案 | 影響 |
|-----|------|------|
| tool_calls sequence | claude_code.tool spans (structured) | ⚠️ 再設計 |
| token_usage | claude_code.token.usage metric | ✓ OK |
| cost_in_usd | claude_code.cost.usage metric | ✓ OK |
| Immediate transcript | 5-60秒 export | ⚠️ Latency |
| Full message history | tool names & decisions | ⚠️ 削減 |

### 採用リスク

1. Tool-call representation の再定義が必須
2. Collector infrastructure の導入・保守
3. Real-time UI は困難（batch wait）
4. Backward compatibility（local との混在）

### 推奨 Next Steps

1. Proof-of-concept：Routine を OTel enable で run、出力確認
2. Rubric 再設計：tool span representation を scheme に追加
3. Ingest layer：OTLP → lathe DB 変換 pipeline
4. Cost validation：Cloud metric 単価が local と一致するか検証

---

## 参考 URLs

### Claude Code
- Sessions: https://code.claude.com/docs/en/sessions.md
- Routines: https://code.claude.com/docs/en/routines.md
- Monitoring: https://code.claude.com/docs/en/monitoring-usage.md

### Managed Agents API
- Sessions: https://platform.claude.com/docs/en/managed-agents/sessions
- Operations: https://platform.claude.com/docs/en/managed-agents/session-operations
- Events & Streaming: https://platform.claude.com/docs/en/managed-agents/events-and-streaming

### Agent SDK
- Observability: https://code.claude.com/docs/en/agent-sdk/observability.md

---

調査完了: 2026-07-08
