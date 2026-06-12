import {
  getEvidenceContext,
  getMcpSessionBundle,
  listMcpSessions,
  queryFindings,
  submitFinding,
  type EvidenceSubjectKind,
  type FindingKind,
  type VerdictFilter,
} from './mcp';

type JsonRecord = Record<string, unknown>;

export const LATHE_MCP_TOOL_NAMES = [
  'list_sessions',
  'get_session_bundle',
  'query_findings',
  'get_evidence_context',
  'submit_finding',
] as const;

export type LatheMcpToolName = (typeof LATHE_MCP_TOOL_NAMES)[number];

export const LATHE_AGENT_MCP_SERVER_NAME = 'lathe';
export const ALLOWED_AGENT_TOOL_NAMES = LATHE_MCP_TOOL_NAMES.map(
  (name) => `mcp__${LATHE_AGENT_MCP_SERVER_NAME}__${name}`,
) as readonly `mcp__lathe__${LatheMcpToolName}`[];

export const DISALLOWED_AGENT_TOOL_NAMES = [
  'Bash',
  'bash',
  'Shell',
  'Task',
  'Agent',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'file_read',
  'file_edit',
  'file_write',
] as const;

export function chatAnalystName(provider: string): string {
  const clean = provider.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'unknown';
  return `chat:${clean}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalLocator(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function normalizeAgentToolName(toolName: string): LatheMcpToolName | null {
  const bare = toolName.startsWith(`mcp__${LATHE_AGENT_MCP_SERVER_NAME}__`)
    ? toolName.slice(`mcp__${LATHE_AGENT_MCP_SERVER_NAME}__`.length)
    : toolName;
  return (LATHE_MCP_TOOL_NAMES as readonly string[]).includes(bare) ? (bare as LatheMcpToolName) : null;
}

export function assertAllowedAgentTool(toolName: string): LatheMcpToolName {
  const normalized = normalizeAgentToolName(toolName);
  if (!normalized) {
    throw new Error(
      `chat agent tool denied: ${toolName}. Allowed tools are ${LATHE_MCP_TOOL_NAMES.join(', ')}`,
    );
  }
  return normalized;
}

function mapFinding(input: JsonRecord, provider?: string) {
  return {
    analyst: provider ? chatAnalystName(provider) : String(input.analyst ?? ''),
    kind: String(input.kind ?? '') as FindingKind,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    confidence: Number(input.confidence),
    projectId: optionalString(input.project_id),
    harnessVersionId: input.harness_version_id === null ? null : optionalString(input.harness_version_id),
    evidence: Array.isArray(input.evidence)
      ? input.evidence.map((item) => {
          const record = item && typeof item === 'object' ? (item as JsonRecord) : {};
          return {
            subjectKind: String(record.subject_kind ?? '') as EvidenceSubjectKind,
            subjectId: optionalString(record.subject_id),
            sessionId: optionalString(record.session_id),
            locator: optionalLocator(record.locator),
            note: optionalString(record.note),
          };
        })
      : [],
  };
}

export async function invokeLatheMcpTool(
  toolName: string,
  args: JsonRecord,
  options: { provider?: string } = {},
): Promise<unknown> {
  const name = assertAllowedAgentTool(toolName);
  if (name === 'list_sessions') {
    const filter = args.filter && typeof args.filter === 'object' ? (args.filter as JsonRecord) : {};
    return listMcpSessions({
      projectId: optionalString(filter.project_id),
      runner: optionalString(filter.runner),
      model: optionalString(filter.model),
      limit: optionalNumber(filter.limit),
      offset: optionalNumber(filter.offset),
    });
  }
  if (name === 'get_session_bundle') {
    const sessionId = optionalString(args.session_id);
    if (!sessionId) throw new Error('get_session_bundle requires session_id');
    return getMcpSessionBundle(sessionId);
  }
  if (name === 'query_findings') {
    const filter = args.filter && typeof args.filter === 'object' ? (args.filter as JsonRecord) : {};
    return queryFindings({
      kind: optionalString(filter.kind) as FindingKind | undefined,
      verdict: optionalString(filter.verdict) as VerdictFilter | undefined,
      sessionId: optionalString(filter.session_id),
      projectId: optionalString(filter.project_id),
      limit: optionalNumber(filter.limit),
      offset: optionalNumber(filter.offset),
    });
  }
  if (name === 'get_evidence_context') {
    return getEvidenceContext({
      subjectKind: String(args.subject_kind ?? '') as EvidenceSubjectKind,
      subjectId: optionalString(args.subject_id),
      sessionId: optionalString(args.session_id),
      locator: optionalLocator(args.locator),
      evidenceId: optionalNumber(args.evidence_id),
    });
  }
  const finding = args.finding && typeof args.finding === 'object' ? (args.finding as JsonRecord) : {};
  return submitFinding(mapFinding(finding, options.provider));
}
