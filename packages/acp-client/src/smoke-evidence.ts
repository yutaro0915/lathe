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

function textFromValue(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textFromValue);
  if (!isRecord(value)) return [];

  const text = typeof value.text === 'string' ? [value.text] : [];
  return [
    ...text,
    ...textFromValue(value.content),
    ...textFromValue(value.toolResponse),
    ...textFromValue(value.rawOutput),
  ];
}

function hasListSessionsResult(update: SessionUpdate): boolean {
  if (!hasToolResponse(update)) return false;
  const meta = nestedRecord(update, '_meta');
  const claudeCode = nestedRecord(meta, 'claudeCode');
  const candidates = [
    ...textFromValue(update.rawOutput),
    ...textFromValue(update.content),
    ...textFromValue(claudeCode.toolResponse),
  ];

  return candidates.some((candidate) => {
    try {
      return Array.isArray(JSON.parse(candidate.trim()));
    } catch {
      return false;
    }
  });
}

export function hasLatheListSessionsCallEvidence(update: SessionUpdate): boolean {
  if (claudeToolName(update) !== LATHE_LIST_SESSIONS_TOOL) return false;
  if (update.sessionUpdate !== 'tool_call_update') return false;
  if (update.status !== 'completed') return false;
  return hasListSessionsResult(update);
}

export function hasLatheServerConnectedEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"name":"lathe"') && text.includes('"status":"connected"');
}

export function hasSubscriptionAuthEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"apiKeySource":"none"') || text.includes('"rateLimitType"');
}
