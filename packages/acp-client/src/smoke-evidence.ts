import type { JsonRecord, SessionUpdate } from './types.js';

const LATHE_LIST_SESSIONS_TOOL = 'mcp__lathe__list_sessions';

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function claudeToolName(update: SessionUpdate): string | undefined {
  const meta = nestedRecord(update, '_meta');
  const claudeCode = nestedRecord(meta, 'claudeCode');
  const toolName = claudeCode.toolName;
  return typeof toolName === 'string' ? toolName : undefined;
}

function hasToolResponse(update: SessionUpdate): boolean {
  const meta = nestedRecord(update, '_meta');
  const claudeCode = nestedRecord(meta, 'claudeCode');
  return claudeCode.toolResponse !== undefined || update.rawOutput !== undefined || update.content !== undefined;
}

export function hasLatheListSessionsCallEvidence(update: SessionUpdate): boolean {
  if (claudeToolName(update) !== LATHE_LIST_SESSIONS_TOOL) return false;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false;
  return update.status === 'completed' || hasToolResponse(update);
}

export function hasLatheServerConnectedEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"name":"lathe"') && text.includes('"status":"connected"');
}

export function hasSubscriptionAuthEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"apiKeySource":"none"') || text.includes('"rateLimitType"');
}
