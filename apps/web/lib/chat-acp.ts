import type { SessionResult, SessionUpdate } from '@lathe/acp-client';
import { runLatheAgentSession } from './lathe-agent-harness';

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
  return runLatheAgentSession({
    adapterEnvPrefix: 'LATHE_CHAT_ACP',
    mcpEnv: { LATHE_MCP_DISABLE_SUBMIT_FINDING: '1' },
    permissionPolicy: 'chat-readonly',
    prompt: input.prompt,
    timeoutMs: Number(process.env.LATHE_CHAT_ACP_TIMEOUT_MS || 180_000),
    signal: input.signal,
    onUpdate: input.onUpdate,
  });
}
