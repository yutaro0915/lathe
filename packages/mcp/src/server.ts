import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  EVIDENCE_SUBJECT_KINDS,
  FINDING_KINDS,
  VERDICT_FILTERS,
  getEvidenceContext,
  getMcpSessionBundle,
  listMcpSessions,
  queryFindings,
  submitFinding,
  type EvidenceSubjectKind,
  type FindingKind,
  type VerdictFilter,
} from '../../../apps/web/lib/mcp.js';

type JsonRecord = Record<string, unknown>;

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalLocator(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function mapFinding(input: JsonRecord) {
  return {
    analyst: String(input.analyst ?? ''),
    kind: String(input.kind ?? '') as FindingKind,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    confidence: Number(input.confidence),
    projectId: optionalString(input.project_id) ?? optionalString(input.projectId),
    harnessVersionId:
      input.harness_version_id === null || input.harnessVersionId === null
        ? null
        : optionalString(input.harness_version_id) ?? optionalString(input.harnessVersionId),
    evidence: Array.isArray(input.evidence)
      ? input.evidence.map((item) => {
          const record = item && typeof item === 'object' ? (item as JsonRecord) : {};
          return {
            subjectKind: String(record.subject_kind ?? record.subjectKind ?? '') as EvidenceSubjectKind,
            subjectId: optionalString(record.subject_id) ?? optionalString(record.subjectId),
            sessionId: optionalString(record.session_id) ?? optionalString(record.sessionId),
            locator: optionalLocator(record.locator),
            note: optionalString(record.note),
          };
        })
      : [],
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'lathe-mcp',
    version: '0.0.0',
  });

  server.registerTool(
    'list_sessions',
    {
      title: 'List Lathe sessions',
      description: 'List session summaries with paging and optional project/runner/model filters.',
      inputSchema: {
        filter: z
          .object({
            project_id: z.string().optional(),
            runner: z.string().optional(),
            model: z.string().optional(),
            limit: z.number().int().positive().max(200).optional(),
            offset: z.number().int().min(0).optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ filter }) =>
      jsonResult(
        await listMcpSessions({
          projectId: optionalString(filter?.project_id),
          runner: optionalString(filter?.runner),
          model: optionalString(filter?.model),
          limit: optionalNumber(filter?.limit),
          offset: optionalNumber(filter?.offset),
        }),
      ),
  );

  server.registerTool(
    'get_session_bundle',
    {
      title: 'Get Lathe session bundle',
      description: 'Return the existing Lathe session bundle used by the web UI.',
      inputSchema: {
        session_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session_id }) => jsonResult(await getMcpSessionBundle(session_id)),
  );

  server.registerTool(
    'query_findings',
    {
      title: 'Query Lathe findings',
      description: 'Query findings by kind, verdict state, project, session, and paging.',
      inputSchema: {
        filter: z
          .object({
            kind: z.enum(FINDING_KINDS).optional(),
            verdict: z.enum(VERDICT_FILTERS).optional(),
            session_id: z.string().optional(),
            project_id: z.string().optional(),
            limit: z.number().int().positive().max(200).optional(),
            offset: z.number().int().min(0).optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ filter }) =>
      jsonResult(
        await queryFindings({
          kind: filter?.kind,
          verdict: filter?.verdict as VerdictFilter | undefined,
          sessionId: optionalString(filter?.session_id),
          projectId: optionalString(filter?.project_id),
          limit: optionalNumber(filter?.limit),
          offset: optionalNumber(filter?.offset),
        }),
      ),
  );

  server.registerTool(
    'get_evidence_context',
    {
      title: 'Get finding evidence context',
      description: 'Resolve an evidence coordinate to the underlying session, event, hunk, PR, or turn context.',
      inputSchema: {
        subject_kind: z.enum(EVIDENCE_SUBJECT_KINDS),
        subject_id: z.string().optional(),
        session_id: z.string().optional(),
        locator: z.record(z.string(), z.unknown()).optional(),
        evidence_id: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ subject_kind, subject_id, session_id, locator, evidence_id }) =>
      jsonResult(
        await getEvidenceContext({
          subjectKind: subject_kind,
          subjectId: subject_id,
          sessionId: session_id,
          locator,
          evidenceId: evidence_id,
        }),
      ),
  );

  server.registerTool(
    'submit_finding',
    {
      title: 'Submit Lathe finding',
      description: 'Validate and insert an analyst finding with required evidence and idempotency.',
      inputSchema: {
        finding: z.object({
          analyst: z.string().min(1),
          kind: z.string().min(1),
          title: z.string().min(1),
          body: z.string().min(1),
          confidence: z.number().min(0).max(1),
          project_id: z.string().optional(),
          harness_version_id: z.string().nullable().optional(),
          evidence: z.array(
            z.object({
              subject_kind: z.string().min(1),
              subject_id: z.string().optional(),
              session_id: z.string().optional(),
              locator: z.record(z.string(), z.unknown()).optional(),
              note: z.string().optional(),
            }),
          ),
        }),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ finding }) => jsonResult(await submitFinding(mapFinding(finding))),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(`[lathe-mcp] ${(error as Error).message}`);
  process.exitCode = 1;
});
