import * as path from 'node:path';
import {
  latheMcpServer,
  runSession,
  type AdapterCommand,
  type McpServer,
  type PermissionRequest,
  type SessionResult,
  type SessionUpdate,
} from '@lathe/acp-client';

const READ_ONLY_LATHE_TOOLS = new Set([
  'mcp__lathe__list_sessions',
  'mcp__lathe__get_session_bundle',
  'mcp__lathe__query_findings',
  'mcp__lathe__get_evidence_context',
  'list_sessions',
  'get_session_bundle',
  'query_findings',
  'get_evidence_context',
]);

export function repoRoot(): string {
  return path.resolve(process.cwd(), '..', '..');
}

export function chatAcpAdapter(): AdapterCommand {
  const raw = process.env.LATHE_CHAT_ACP_ADAPTER;
  if (raw === 'fake') {
    return {
      command: process.execPath,
      args: [path.resolve(repoRoot(), 'packages/acp-client/test/fixtures/fake-acp-agent.mjs')],
    };
  }
  if (raw?.trim().startsWith('{')) return JSON.parse(raw) as AdapterCommand;
  if (raw?.trim()) return { command: process.execPath, args: [raw.trim()] };
  const command = process.env.LATHE_CHAT_ACP_COMMAND || 'npx';
  const args = process.env.LATHE_CHAT_ACP_ARGS
    ? JSON.parse(process.env.LATHE_CHAT_ACP_ARGS) as string[]
    : ['-y', '@agentclientprotocol/claude-agent-acp@latest'];
  return { command, args };
}

function chatMcpServers(): McpServer[] {
  const server = latheMcpServer({ repoRoot: repoRoot(), databaseUrl: process.env.DATABASE_URL });
  if ('env' in server) server.env = [...server.env, { name: 'LATHE_MCP_DISABLE_SUBMIT_FINDING', value: '1' }];
  return [server];
}

function permissionToolName(request: PermissionRequest): string {
  const toolCall = request.toolCall as Record<string, unknown> | undefined;
  const meta = toolCall?._meta;
  const metaTool = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).toolName
    : undefined;
  // claude-agent-acp v0.49.0 puts the MCP tool name in `toolCall.title` (kind:"other")
  // and does NOT set `name`/`toolName`. Read `title` too, otherwise every MCP tool
  // permission request resolves to '' and is rejected — even allow-listed lathe tools.
  const raw = [toolCall?.name, toolCall?.toolName, metaTool, toolCall?.title]
    .find((item) => typeof item === 'string');
  return typeof raw === 'string' ? raw : '';
}

function selectPermission(request: PermissionRequest, allow: boolean) {
  const kinds = allow
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  const option = request.options.find((item) => kinds.includes(item.kind));
  return option ? { outcome: 'selected' as const, optionId: option.optionId } : { outcome: 'cancelled' as const };
}

export function allowChatPermission(request: PermissionRequest) {
  const toolName = permissionToolName(request);
  return selectPermission(request, READ_ONLY_LATHE_TOOLS.has(toolName));
}

export function assistantDeltaFromUpdate(update: SessionUpdate): string {
  const kind = String(update.sessionUpdate ?? '');
  if (kind !== 'agent_message_chunk' && kind !== 'assistant_message_chunk') return '';
  return contentText(update.content);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (typeof record.text === 'string') return record.text;
  return '';
}

export async function runChatAgent(input: {
  prompt: string;
  onUpdate: (update: SessionUpdate) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<SessionResult> {
  return runSession({
    adapter: chatAcpAdapter(),
    cwd: repoRoot(),
    mcpServers: chatMcpServers(),
    sessionMeta: {
      claudeCode: {
        emitRawSDKMessages: true,
        // The lathe MCP tools reach the model via `mcpServers` (chatMcpServers), NOT
        // via `options.tools` — that field is claude-agent-acp's built-in tool selector
        // (acp-agent.js: `tools = userProvidedOptions?.tools ?? preset`). Putting MCP
        // names there yielded no usable toolset, so the agent hallucinated the tool call
        // as text. Live-verified: `tools: []` ALSO suppresses the MCP tools (the agent
        // still hallucinated), so we OMIT `tools` and let it default to the claude_code
        // preset; the MCP tools then surface and the agent really calls
        // mcp__lathe__list_sessions. Built-in edit/bash is restricted at the permission
        // gate (allowChatPermission denies anything outside READ_ONLY_LATHE_TOOLS) plus
        // the read-only MCP server (LATHE_MCP_DISABLE_SUBMIT_FINDING=1).
        // settingSources:[] stops the agent inheriting the user's ~/.claude config
        // (19 personal skills) which would otherwise leak in via the claude-agent-acp
        // default of ["user","project","local"] (D24 violation). Live-verified gone.
        options: { settingSources: [] },
      },
    },
    prompt: input.prompt,
    timeoutMs: Number(process.env.LATHE_CHAT_ACP_TIMEOUT_MS || 180_000),
    signal: input.signal,
    onUpdate: input.onUpdate,
    onPermission: allowChatPermission,
  });
}
