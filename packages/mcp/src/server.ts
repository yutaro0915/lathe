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
  type EvidenceSubjectKind,
  type FindingKind,
  type VerdictFilter,
} from '@lathe/domain';
import { getMcpSessionBundle } from './session-bundle';
import { getSessionEvents, listMcpSessions } from './sessions';
import {
  getEvidenceContext,
  queryFindings,
  submitFinding,
} from './service';

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

function serializedJsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

const locatorSchema = z
  .record(z.string(), z.unknown())
  .refine((locator) => serializedJsonLength(locator) <= FINDING_LOCATOR_MAX_LENGTH, {
    message: `locator must be ${FINDING_LOCATOR_MAX_LENGTH} characters or fewer`,
  });

function mapFinding(input: JsonRecord) {
  const analysis = input.analysis && typeof input.analysis === 'object' && !Array.isArray(input.analysis)
    ? (input.analysis as JsonRecord)
    : undefined;
  return {
    analyst: String(input.analyst ?? ''),
    kind: String(input.kind ?? '') as FindingKind,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    confidence: Number(input.confidence),
    projectId: optionalString(input.project_id),
    harnessVersionId: input.harness_version_id === null ? null : optionalString(input.harness_version_id),
    analysis: analysis
      ? {
          causeHypothesis: optionalString(analysis.cause_hypothesis),
          agentIntent: optionalString(analysis.agent_intent),
          impact: optionalString(analysis.impact),
        }
      : undefined,
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
  const onlySubmitFinding = process.env.LATHE_MCP_ONLY_SUBMIT_FINDING === '1';

  if (!onlySubmitFinding) {
    server.registerTool(
      'list_sessions',
      {
        title: 'List Lathe sessions',
        description: 'List session summaries with paging, optional project/runner/model/class filters, and triage fields (status, turn/tool/error counts, cost, duration, class). Returns { total, sessions }.',
        inputSchema: {
          filter: z
            .object({
              project_id: z.string().optional(),
              runner: z.string().optional(),
              model: z.string().optional(),
              class: z.string().optional(),
              include_classes: z.array(z.string()).optional(),
              limit: z.number().int().positive().max(200).optional(),
              offset: z.number().int().min(0).optional(),
              order_by: z.enum(['started_at', 'cost_usd', 'error_count', 'turn_count', 'duration_ms']).optional(),
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
            sessionClass: optionalString(filter?.class),
            includeClasses: filter?.include_classes,
            limit: optionalNumber(filter?.limit),
            offset: optionalNumber(filter?.offset),
            orderBy: optionalString(filter?.order_by),
          }),
        ),
    );

  server.registerTool(
    'get_session_events',
    {
      title: 'List session turns (spine) without event bodies',
      description: 'List session turns (spine) without event bodies, filterable by seq range / subagent / type. Returns { total, seqRange, events }.',
      inputSchema: {
        session_id: z.string().min(1),
        seq_from: z.number().int().min(0).optional(),
        seq_to: z.number().int().min(0).optional(),
        subagent: z.string().optional(),
        types: z.array(z.string()).optional(),
        errors_only: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session_id, seq_from, seq_to, subagent, types, errors_only, limit, offset }) =>
      jsonResult(
        await getSessionEvents({
          sessionId: session_id,
          seqFrom: seq_from,
          seqTo: seq_to,
          subagent: optionalString(subagent),
          types,
          errorsOnly: errors_only,
          limit: optionalNumber(limit),
          offset: optionalNumber(offset),
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

  }

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
          analysis: z
            .object({
              cause_hypothesis: z.string().max(1200).nullable().optional(),
              agent_intent: z.string().max(1200).nullable().optional(),
              impact: z.string().max(1200).nullable().optional(),
            })
            .optional(),
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
    async ({ finding }) => {
      if (process.env.LATHE_MCP_DISABLE_SUBMIT_FINDING === '1') {
        throw new Error('submit_finding is disabled for this Lathe MCP session');
      }
      return jsonResult(await submitFinding(mapFinding(finding)));
    },
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
