import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  EVIDENCE_SUBJECT_KINDS,
  FINDING_BODY_MAX_LENGTH,
  FINDING_EVIDENCE_MAX_ITEMS,
  FINDING_KINDS,
  FINDING_LOCATOR_MAX_LENGTH,
  FINDING_NOTE_MAX_LENGTH,
  FINDING_TITLE_MAX_LENGTH,
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

function chatAnalystName(provider: string): string {
  const clean = provider.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'unknown';
  return `chat:${clean}`;
}

function analystForProcess(input: JsonRecord): string {
  if (process.env.LATHE_INTERNAL_AGENT === 'chat') {
    return chatAnalystName(process.env.LATHE_CHAT_PROVIDER || 'unknown');
  }
  return String(input.analyst ?? '');
}

function serializedJsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

const locatorSchema = z
  .record(z.string(), z.unknown())
  .refine((locator) => serializedJsonLength(locator) <= FINDING_LOCATOR_MAX_LENGTH, {
    message: `locator must be ${FINDING_LOCATOR_MAX_LENGTH} characters or fewer`,
  });

function mapFinding(input: JsonRecord) {
  return {
    analyst: analystForProcess(input),
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
          kind: z.enum(FINDING_KINDS),
          title: z.string().min(1).max(FINDING_TITLE_MAX_LENGTH),
          body: z.string().min(1).max(FINDING_BODY_MAX_LENGTH),
          confidence: z.number().min(0).max(1),
          project_id: z.string().optional(),
          harness_version_id: z.string().nullable().optional(),
          evidence: z
            .array(
              z.object({
                subject_kind: z.enum(EVIDENCE_SUBJECT_KINDS),
                subject_id: z.string().optional(),
                session_id: z.string().optional(),
                locator: locatorSchema.optional(),
                note: z.string().max(FINDING_NOTE_MAX_LENGTH).optional(),
              }),
            )
            .min(1)
            .max(FINDING_EVIDENCE_MAX_ITEMS),
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
