import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { latheMcpServer, runSession, type AdapterCommand, type McpServer, type PermissionRequest, type SessionUpdate } from '@lathe/acp-client';
import { COST_ANOMALY_BASELINE } from '@lathe/shared';
import {
  FINDING_KINDS,
  submitFinding,
  type FindingKind,
  type SubmitFindingInput,
} from '../lib/mcp';
import { getPool, queryOne, queryRows } from '../lib/postgres';
import type { IngestNotifyPayload } from './ingest/notify';

export type AnalystCandidate = 'rules-v1' | 'llm-v1' | 'hybrid-v1';
export type LlmProviderMode = 'none' | 'claude-acp';

interface TurnScope {
  sessionId: string;
  seq: number;
}

export interface RunAnalystOptions {
  candidate: AnalystCandidate;
  sessionId?: string;
  sessionIds?: string[];
  turn?: TurnScope;
  limit?: number;
  submit?: boolean;
  llmProviderMode?: LlmProviderMode;
  maxLlmSessions?: number;
  source?: 'cli' | 'notify' | 'smoke';
}

interface AnalystFindingDraft extends SubmitFindingInput {
  detector: string;
}

interface RunAnalystResult {
  candidate: AnalystCandidate;
  generated: number;
  submitted: number;
  created: number;
  skipped: boolean;
  skipReason?: string;
  findings: Array<{
    findingId?: number;
    created?: boolean;
    kind: FindingKind;
    title: string;
    primarySessionId?: string;
  }>;
  logs: string[];
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  runner: string;
  model: string | null;
  cost_usd: number | null;
  error_count: number;
  edit_count: number;
  turn_count: number;
  harness_version_id: string | null;
  cost_group_size: number;
  cost_group_median_usd: number | null;
  cost_threshold_usd: number;
  cost_anomaly: boolean;
}

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  title: string;
  body: string | null;
  command: string | null;
  exit_code: number | null;
}

interface HunkSignalRow {
  session_id: string;
  project_id: string;
  harness_version_id: string | null;
  hunks: number;
  unattributed: number;
  first_hunk_id: string | null;
  first_path: string | null;
}

interface KnownIncident {
  id: string;
  label: string;
  session_id: string;
  expected_kind: FindingKind;
  conditions: {
    title_contains?: string;
    event_contains?: string[];
    min_cost_multiplier?: number;
    turn_seq?: number;
  };
}

interface KnownIncidentFile {
  version: number;
  incidents: KnownIncident[];
}

interface SmokeResult {
  ok: true;
  recall: Array<{ candidate: AnalystCandidate; found: number; total: number; skipped?: string }>;
  createdFindingsCleaned: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const INTERNAL_ANALYST_TAG = 'lathe-internal-analyst';
const PHENOMENON_LINT_PATTERNS = [
  /(?:CLAUDE\.md|AGENTS\.md)\s*(?:を|に|へ)[^。.\n]*(?:編集|追加|修正|変更|書き換)/i,
  /(?:edit|modify|change|append to)\s+(?:CLAUDE\.md|AGENTS\.md)/i,
];
const RISKY_COMMAND = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|kill\s+-9|pkill\s+-f|drop\s+database|truncate\s+table|docker\s+compose\s+down)\b/i;
const SELF_SUFFICIENT_FIXTURE = /(自己充足|fixture).{0,80}(実データ|検出|循環|自己充足|0 行|0件)/i;
const PORT_COLLISION = /EADDRINUSE|address already in use/i;
const DATA_DEPENDENT_FLAKE = /(データ依存|flake|flaky|EADDRINUSE|address already in use)/i;
const BISECTION_ACCIDENT = /(二分法事故|二分法|existence-proof|存在証明).{0,120}(無視|推測|事故|誤り|見落と)/i;

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value ?? DEFAULT_LIMIT)));
}

function isFindingKind(value: string): value is FindingKind {
  return (FINDING_KINDS as readonly string[]).includes(value);
}

function cleanText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shorten(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function primarySessionId(finding: SubmitFindingInput): string | undefined {
  const primary = finding.evidence[0];
  return primary?.sessionId ?? (primary?.subjectKind === 'session' ? primary.subjectId : undefined);
}

function findingKey(finding: SubmitFindingInput): string {
  const primary = finding.evidence[0];
  return stableJson({
    analyst: finding.analyst,
    kind: finding.kind,
    subjectKind: primary?.subjectKind,
    subjectId: primary?.subjectId ?? '',
    sessionId: primary?.sessionId ?? '',
    locator: primary?.locator ?? {},
  });
}

function turnEvidence(sessionId: string, seq: number, note: string): SubmitFindingInput['evidence'][number] {
  return {
    subjectKind: 'turn',
    sessionId,
    locator: { seq },
    note,
  };
}

function sessionEvidence(sessionId: string, note: string): SubmitFindingInput['evidence'][number] {
  return {
    subjectKind: 'session',
    subjectId: sessionId,
    sessionId,
    locator: {},
    note,
  };
}

function makeFinding(input: {
  analyst: AnalystCandidate;
  detector: string;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  projectId: string;
  harnessVersionId: string | null;
  analysis?: SubmitFindingInput['analysis'] | null;
  evidence: SubmitFindingInput['evidence'];
}): AnalystFindingDraft {
  return {
    analyst: input.analyst,
    kind: input.kind,
    title: shorten(input.title, 500),
    body: shorten(input.body, 20_000),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    projectId: input.projectId,
    harnessVersionId: input.harnessVersionId,
    analysis: input.analysis ?? undefined,
    evidence: input.evidence,
    detector: input.detector,
  };
}

function sessionFilter(options: RunAnalystOptions): { sql: string; params: unknown[] } {
  if (options.turn) return { sql: 's.id = $1', params: [options.turn.sessionId] };
  if (options.sessionId) return { sql: 's.id = $1', params: [options.sessionId] };
  const ids = options.sessionIds?.filter(Boolean);
  if (ids?.length) return { sql: 's.id = ANY($1::text[])', params: [ids] };
  return { sql: 'TRUE', params: [] };
}

async function listTargetSessions(options: RunAnalystOptions): Promise<SessionRow[]> {
  const filter = sessionFilter(options);
  const params = [
    COST_ANOMALY_BASELINE.minimumGroupSize,
    COST_ANOMALY_BASELINE.absoluteFloorUsd,
    COST_ANOMALY_BASELINE.medianMultiplier,
    ...filter.params,
  ];
  const whereIndexOffset = 3;
  let where = filter.sql;
  for (let i = filter.params.length; i >= 1; i--) {
    where = where.replaceAll(`$${i}`, `$${i + whereIndexOffset}`);
  }
  return queryRows<SessionRow>(
    `WITH cost_baseline AS (
       SELECT runner,
              COUNT(cost_usd)::int AS cost_group_size,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS cost_group_median_usd
         FROM sessions
        WHERE cost_usd IS NOT NULL
        GROUP BY runner
     ),
     scored AS (
       SELECT s.*,
              COALESCE(b.cost_group_size, 0)::int AS cost_group_size,
              b.cost_group_median_usd,
              CASE
                WHEN s.cost_usd IS NULL THEN $2::float8
                WHEN COALESCE(b.cost_group_size, 0) < $1::int THEN $2::float8
                WHEN b.cost_group_median_usd IS NULL THEN $2::float8
                ELSE GREATEST(b.cost_group_median_usd * $3::float8, $2::float8)
              END AS cost_threshold_usd
         FROM sessions s
         LEFT JOIN cost_baseline b ON b.runner = s.runner
     )
     SELECT *,
            (cost_usd IS NOT NULL AND cost_usd > cost_threshold_usd) AS cost_anomaly
       FROM scored s
      WHERE ${where}
      ORDER BY
            CASE WHEN (cost_usd IS NOT NULL AND cost_usd > cost_threshold_usd) THEN 0 ELSE 1 END,
            error_count DESC,
            cost_usd DESC NULLS LAST,
            seq ASC`,
    params,
  );
}

async function listEventsForSessions(sessionIds: string[], options: RunAnalystOptions): Promise<EventRow[]> {
  if (!sessionIds.length) return [];
  if (options.turn) {
    return queryRows<EventRow>(
      `SELECT id,session_id,seq,type,title,body,command,exit_code
         FROM transcript_events
        WHERE session_id = $1
          AND seq BETWEEN $2 AND $3
        ORDER BY seq ASC, id ASC`,
      [options.turn.sessionId, Math.max(1, options.turn.seq - 3), options.turn.seq + 3],
    );
  }
  return queryRows<EventRow>(
    `SELECT id,session_id,seq,type,title,body,command,exit_code
       FROM transcript_events
      WHERE session_id = ANY($1::text[])
      ORDER BY session_id ASC, seq ASC, id ASC`,
    [sessionIds],
  );
}

function eventText(event: EventRow): string {
  return [event.title, event.command, event.body].filter(Boolean).join('\n');
}

function normalizeCommand(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/(["'])(?:[^"']{20,})\1/g, '$1…$1')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 220);
}

function detectFailureLoops(
  analyst: AnalystCandidate,
  sessions: Map<string, SessionRow>,
  events: EventRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  const bySession = new Map<string, EventRow[]>();
  for (const event of events) {
    if (!bySession.has(event.session_id)) bySession.set(event.session_id, []);
    bySession.get(event.session_id)!.push(event);
  }

  for (const [sessionId, sessionEvents] of bySession) {
    const session = sessions.get(sessionId);
    if (!session) continue;
    const failed = sessionEvents.filter((event) => event.exit_code != null && event.exit_code !== 0);
    if (options.turn) {
      const scoped = failed.find((event) => event.seq === options.turn?.seq);
      if (scoped) {
        out.push(
          makeFinding({
            analyst,
            detector: 'failed_turn',
            kind: 'failure_loop',
            title: `Failed command at turn ${scoped.seq}`,
            body: `The selected turn has a non-zero command result. The observable issue is a failed execution step at the requested coordinate, which can be reviewed without broadening the analysis scope.`,
            confidence: 0.91,
            projectId: session.project_id,
            harnessVersionId: session.harness_version_id,
            evidence: [turnEvidence(sessionId, scoped.seq, 'selected failed turn')],
          }),
        );
      }
      continue;
    }

    const byCommand = new Map<string, EventRow[]>();
    for (const event of failed) {
      const normalized = normalizeCommand(event.command || event.title);
      if (!normalized) continue;
      if (!byCommand.has(normalized)) byCommand.set(normalized, []);
      byCommand.get(normalized)!.push(event);
    }
    for (const [command, items] of byCommand) {
      if (items.length < 3) continue;
      const first = items[0];
      out.push(
        makeFinding({
          analyst,
          detector: 'repeated_failed_command',
          kind: 'failure_loop',
          title: `Repeated failed command pattern in ${session.title}`,
          body: `The transcript contains ${items.length} non-zero executions of the same command pattern (${shorten(command, 120)}). The phenomenon is a repeated failed execution loop rather than an isolated failure.`,
          confidence: Math.min(0.97, 0.82 + items.length * 0.02),
          projectId: session.project_id,
          harnessVersionId: session.harness_version_id,
          evidence: [
            turnEvidence(sessionId, first.seq, 'first failed command in repeated pattern'),
            ...items.slice(1, 4).map((event) => turnEvidence(sessionId, event.seq, 'later failed command in repeated pattern')),
          ],
        }),
      );
    }

    const seenCueDetectors = new Set<string>();
    const cueEvents = sessionEvents.filter((event) => {
      const text = eventText(event);
      return DATA_DEPENDENT_FLAKE.test(text) || SELF_SUFFICIENT_FIXTURE.test(text) || PORT_COLLISION.test(text);
    });
    for (const event of cueEvents) {
      const text = eventText(event);
      const fixture = SELF_SUFFICIENT_FIXTURE.test(text);
      const portCollision = PORT_COLLISION.test(text);
      const detector = fixture ? 'self_sufficient_fixture_cue' : portCollision ? 'port_collision_cue' : 'data_dependent_flake_cue';
      if (seenCueDetectors.has(detector)) continue;
      seenCueDetectors.add(detector);
      out.push(
        makeFinding({
          analyst,
          detector,
          kind: 'failure_loop',
          title: fixture
            ? `Fixture-only validation cue in ${session.title}`
            : portCollision
              ? `Port collision failure cue in ${session.title}`
              : `Data-dependent failure cue in ${session.title}`,
          body: fixture
            ? `The transcript describes a validation path that passed fixture-like checks while real data behavior diverged. The phenomenon is a self-contained verification loop that did not cover the observed production-shaped data.`
            : portCollision
              ? `The transcript shows an EADDRINUSE or address-in-use failure. The phenomenon is a local runtime port collision, not stable product behavior.`
            : `The transcript calls out a failure as data-dependent or environment-dependent. The phenomenon is a test result that changed with the selected data or occupied runtime resource, not a stable product behavior.`,
          confidence: fixture ? 0.9 : portCollision ? 0.89 : 0.88,
          projectId: session.project_id,
          harnessVersionId: session.harness_version_id,
          evidence: [turnEvidence(sessionId, event.seq, fixture ? 'fixture/self-sufficiency cue' : portCollision ? 'port collision cue' : 'data-dependent failure cue')],
        }),
      );
      if (seenCueDetectors.size >= 3) break;
    }
  }
  return out;
}

async function detectUnattributedDiff(
  analyst: AnalystCandidate,
  options: RunAnalystOptions,
): Promise<AnalystFindingDraft[]> {
  const filter = sessionFilter(options);
  let where = filter.sql.replaceAll('s.', '');
  if (options.turn) {
    where = `cf.session_id = $1 AND EXISTS (
      SELECT 1
        FROM attributions a
        JOIN transcript_events e ON e.id = a.event_id
       WHERE a.hunk_id = h.id
         AND e.session_id = $1
         AND e.seq = $2
    )`;
  } else if (options.sessionId || options.sessionIds?.length) {
    where = where.replaceAll('id', 'cf.session_id');
  } else {
    where = 'TRUE';
  }
  const params = options.turn ? [options.turn.sessionId, options.turn.seq] : filter.params;
  const rows = await queryRows<HunkSignalRow>(
    `SELECT cf.session_id,
            s.project_id,
            s.harness_version_id,
            COUNT(*)::int AS hunks,
            SUM(CASE WHEN a.event_id IS NULL OR a.confidence = 'unattributed' THEN 1 ELSE 0 END)::int AS unattributed,
            MIN(h.id) FILTER (WHERE a.event_id IS NULL OR a.confidence = 'unattributed') AS first_hunk_id,
            MIN(cf.path) FILTER (WHERE a.event_id IS NULL OR a.confidence = 'unattributed') AS first_path
       FROM changed_files cf
       JOIN sessions s ON s.id = cf.session_id
       JOIN diff_hunks h ON h.file_id = cf.id
       LEFT JOIN attributions a ON a.hunk_id = h.id
      WHERE ${where}
      GROUP BY cf.session_id,s.project_id,s.harness_version_id
     HAVING COUNT(*) >= 3
        AND SUM(CASE WHEN a.event_id IS NULL OR a.confidence = 'unattributed' THEN 1 ELSE 0 END)::float8 / COUNT(*) >= 0.25
      ORDER BY unattributed DESC, hunks DESC
      LIMIT 20`,
    params,
  );
  return rows.map((row) =>
    makeFinding({
      analyst,
      detector: 'unattributed_hunk_ratio',
      kind: 'unattributed_diff',
      title: `Unattributed diff concentration in ${row.session_id.slice(0, 8)}`,
      body: `The session has ${row.unattributed}/${row.hunks} diff hunks without a direct event attribution. The phenomenon is a diff-to-transcript gap that weakens traceability for the changed files.`,
      confidence: Math.min(0.92, 0.65 + row.unattributed / Math.max(1, row.hunks)),
      projectId: row.project_id,
      harnessVersionId: row.harness_version_id,
      evidence: [
        row.first_hunk_id
          ? {
              subjectKind: 'hunk',
              subjectId: row.first_hunk_id,
              sessionId: row.session_id,
              locator: { path: row.first_path ?? undefined },
              note: 'first unattributed hunk',
            }
          : sessionEvidence(row.session_id, 'session with unattributed diff concentration'),
      ],
    }),
  );
}

function detectExcessCost(analyst: AnalystCandidate, sessions: SessionRow[], options: RunAnalystOptions): AnalystFindingDraft[] {
  if (options.turn) return [];
  return sessions
    .filter((session) => session.cost_anomaly && session.cost_usd != null)
    .map((session) =>
      makeFinding({
        analyst,
        detector: 'cost_anomaly_baseline',
        kind: 'excess_cost',
        title: `Cost exceeds ${session.runner} baseline in ${session.title}`,
        body: `The session cost was $${session.cost_usd!.toFixed(2)}, above the current ${session.runner} threshold of $${session.cost_threshold_usd.toFixed(2)} derived from group size ${session.cost_group_size}. The phenomenon is an unusually expensive run compared with nearby observed sessions.`,
        confidence: Math.min(0.96, 0.78 + session.cost_usd! / Math.max(session.cost_threshold_usd * 10, 1)),
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        evidence: [sessionEvidence(session.id, 'cost anomaly session')],
      }),
    );
}

function detectRiskyActions(
  analyst: AnalystCandidate,
  sessions: Map<string, SessionRow>,
  events: EventRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  for (const event of events) {
    if (options.turn && event.seq !== options.turn.seq) continue;
    const session = sessions.get(event.session_id);
    if (!session) continue;
    const text = eventText(event);
    const risky = RISKY_COMMAND.test(text);
    const bisection = BISECTION_ACCIDENT.test(text);
    if (!risky && !bisection) continue;
    out.push(
      makeFinding({
        analyst,
        detector: risky ? 'risky_command_pattern' : 'bisection_accident_cue',
        kind: 'risky_action',
        title: risky ? `High-impact shell action in ${session.title}` : `Premature binary framing cue in ${session.title}`,
        body: risky
          ? `The transcript includes a shell action with broad destructive or process-killing potential. The phenomenon is an operation whose blast radius depends on the current working directory, target path, or active processes.`
          : `The transcript describes a binary framing mistake before confirming how working implementations behave. The phenomenon is a reasoning shortcut that narrowed the design space before existence evidence was checked.`,
        confidence: risky ? 0.87 : 0.84,
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        evidence: [turnEvidence(event.session_id, event.seq, risky ? 'risky command cue' : 'binary framing cue')],
      }),
    );
  }
  return out;
}

async function runRulesCandidate(
  analyst: AnalystCandidate,
  options: RunAnalystOptions,
): Promise<AnalystFindingDraft[]> {
  const sessions = await listTargetSessions(options);
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const events = await listEventsForSessions([...bySession.keys()], options);
  return [
    ...detectFailureLoops(analyst, bySession, events, options),
    ...(await detectUnattributedDiff(analyst, options)),
    ...detectExcessCost(analyst, sessions, options),
    ...detectRiskyActions(analyst, bySession, events, options),
  ];
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '..', '..');
}

function analystAcpAdapter(): AdapterCommand {
  const command = process.env.LATHE_ANALYST_ACP_COMMAND || 'npx';
  const args = process.env.LATHE_ANALYST_ACP_ARGS
    ? JSON.parse(process.env.LATHE_ANALYST_ACP_ARGS) as string[]
    : ['-y', '@agentclientprotocol/claude-agent-acp@latest'];
  return {
    command,
    args,
    env: {
      LATHE_INTERNAL_ANALYST_TAG: INTERNAL_ANALYST_TAG,
    },
  };
}

function analystMcpServers(submit: boolean): McpServer[] {
  const server = latheMcpServer({ repoRoot: repoRoot(), databaseUrl: process.env.DATABASE_URL });
  if ('env' in server) {
    server.env = [...server.env, { name: 'LATHE_MCP_ONLY_SUBMIT_FINDING', value: '1' }];
    if (!submit) server.env = [...server.env, { name: 'LATHE_MCP_DISABLE_SUBMIT_FINDING', value: '1' }];
  }
  return [server];
}

function permissionToolName(request: PermissionRequest): string {
  const raw = [
    request.toolCall?.name,
    request.toolCall?.toolName,
    request.toolCall?._meta && typeof request.toolCall._meta === 'object' && !Array.isArray(request.toolCall._meta)
      ? (request.toolCall._meta as Record<string, unknown>).toolName
      : undefined,
  ].find((item) => typeof item === 'string');
  return typeof raw === 'string' ? raw : '';
}

function allowPermission(request: PermissionRequest, submit: boolean) {
  const toolName = permissionToolName(request);
  if (!submit && /submit_finding/.test(toolName)) {
    const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject ? { outcome: 'selected' as const, optionId: reject.optionId } : { outcome: 'cancelled' as const };
  }
  const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always') ?? request.options[0];
  return allow ? { outcome: 'selected' as const, optionId: allow.optionId } : { outcome: 'cancelled' as const };
}

function debugAcpUpdate(update: SessionUpdate): void {
  if (process.env.LATHE_ANALYST_DEBUG_ACP !== '1') return;
  const meta = update._meta && typeof update._meta === 'object' && !Array.isArray(update._meta)
    ? update._meta as Record<string, unknown>
    : {};
  const claude = meta.claudeCode && typeof meta.claudeCode === 'object' && !Array.isArray(meta.claudeCode)
    ? meta.claudeCode as Record<string, unknown>
    : {};
  console.error(
    `[analyst:acp] update=${String(update.sessionUpdate ?? '')} status=${String(update.status ?? '')} tool=${String(claude.toolName ?? update.toolName ?? '')}`,
  );
}

async function buildSessionDigests(options: RunAnalystOptions): Promise<Array<{ session: SessionRow; events: EventRow[] }>> {
  const target = await listTargetSessions(options);
  const maxSessions = options.sessionId || options.turn || options.sessionIds?.length ? target.length : (options.maxLlmSessions ?? 3);
  const sessions = target.slice(0, Math.max(1, maxSessions));
  const events = await listEventsForSessions(
    sessions.map((session) => session.id),
    options,
  );
  return sessions.map((session) => {
    const sessionEvents = events
      .filter((event) => event.session_id === session.id)
      .filter((event, index) => {
        if (options.turn) return true;
        const text = eventText(event);
        return index < 12 || event.exit_code !== 0 || DATA_DEPENDENT_FLAKE.test(text) || SELF_SUFFICIENT_FIXTURE.test(text) || RISKY_COMMAND.test(text) || BISECTION_ACCIDENT.test(text);
      })
      .slice(0, 18);
    return { session, events: sessionEvents };
  });
}

function digestText(digests: Array<{ session: SessionRow; events: EventRow[] }>): string {
  return digests
    .map(({ session, events }) => {
      const header = [
        `session_id=${session.id}`,
        `title=${session.title}`,
        `runner=${session.runner}`,
        `cost_usd=${session.cost_usd ?? 'null'}`,
        `cost_threshold=${session.cost_threshold_usd}`,
        `errors=${session.error_count}`,
        `turns=${session.turn_count}`,
      ].join(' | ');
      const eventLines = events.map((event) =>
        [
          `seq=${event.seq}`,
          `type=${event.type}`,
          `exit=${event.exit_code ?? 'null'}`,
          `title=${shorten(event.title, 100)}`,
          event.command ? `cmd=${shorten(event.command, 120)}` : '',
          event.body ? `body=${shorten(event.body, 180)}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      );
      return `${header}\n${eventLines.join('\n')}`;
    })
    .join('\n\n---\n\n');
}

interface SubmittedFindingRow {
  id: number;
  kind: FindingKind;
  title: string;
  session_id: string | null;
}

function acpFindingInstructions(analyst: Exclude<AnalystCandidate, 'rules-v1'>, submit: boolean): string {
  return `You are the Lathe analyst running as a non-interactive ACP consumer.

Use the Lathe MCP server. ${submit ? 'Submit findings by calling mcp__lathe__submit_finding.' : 'Dry-run mode: do not call submit_finding.'}

Finding contract:
- analyst must be "${analyst}".
- kind must be one of: failure_loop, unattributed_diff, excess_cost, risky_action.
- evidence must point to a provided session_id, preferably a turn with locator {"seq": number}.
- include analysis with keys cause_hypothesis, agent_intent, impact.
- cause_hypothesis must name a concrete mechanism visible in transcript evidence, not just restate the finding kind.
- agent_intent must cite the user request or task being pursued.
- impact must explain why that mechanism matters for reviewing this run.
- For EADDRINUSE, occupied ports, tmux/dev-server state, data-dependent flakes, or external runtimes, explicitly distinguish environment/runtime/setup state from product/harness behavior and say whether a code/harness fix is implicated.
- Describe observable behavior only. Do not instruct anyone to edit CLAUDE.md, AGENTS.md, hooks, or harness files.
- Submit 1 to 5 high-signal findings. Avoid generic wording such as "needs further investigation" or "same failing evidence."`;
}

function mcpSubmitExample(analyst: AnalystCandidate): string {
  return `submit_finding argument shape:
{
  "finding": {
    "analyst": "${analyst}",
    "kind": "failure_loop",
    "title": "Short phenomenon title",
    "body": "Observable behavior and evidence summary.",
    "confidence": 0.82,
    "project_id": "optional when evidence can infer it",
    "harness_version_id": null,
    "analysis": {
      "cause_hypothesis": "Concrete mechanism from the evidence.",
      "agent_intent": "User/task intent from the transcript.",
      "impact": "Why the mechanism matters, including env/runtime/setup vs product/harness boundary when relevant."
    },
    "evidence": [
      { "subject_kind": "turn", "session_id": "session id", "locator": { "seq": 3 }, "note": "why this turn is primary" }
    ]
  }
}`;
}

async function querySubmittedCandidateFindings(
  analyst: AnalystCandidate,
  sessionIds: string[],
): Promise<SubmittedFindingRow[]> {
  if (!sessionIds.length) return [];
  return queryRows<SubmittedFindingRow>(
    `SELECT DISTINCT ON (f.id)
            f.id,
            f.kind,
            f.title,
            COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END) AS session_id
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = $1
        AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))
      ORDER BY f.id ASC, fe.id ASC`,
    [analyst, sessionIds],
  );
}

function submittedRowsToResult(
  options: RunAnalystOptions,
  beforeIds: Set<number>,
  after: SubmittedFindingRow[],
  logs: string[],
): RunAnalystResult {
  const selected = after.filter((row) => !beforeIds.has(row.id));
  return {
    candidate: options.candidate,
    generated: selected.length,
    submitted: options.submit === false ? 0 : selected.length,
    created: selected.length,
    skipped: false,
    findings: selected.map((row) => ({
      findingId: row.id,
      created: true,
      kind: row.kind,
      title: row.title,
      primarySessionId: row.session_id ?? undefined,
    })),
    logs,
  };
}

async function runAcpSession(input: {
  analyst: Exclude<AnalystCandidate, 'rules-v1'>;
  prompt: string;
  sessionIds: string[];
  options: RunAnalystOptions;
}): Promise<RunAnalystResult> {
  if (input.options.llmProviderMode === 'none') {
    return {
      candidate: input.options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: 'forced no-provider mode',
      findings: [],
      logs: [`skip ${input.analyst}: forced no-provider mode`],
    };
  }

  const submit = input.options.submit !== false;
  if (!submit) {
    return {
      candidate: input.options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: false,
      findings: [],
      logs: [`dry-run ${input.analyst}: ACP submit suppressed`],
    };
  }
  const before = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
  const beforeIds = new Set(before.map((row) => row.id));
  const updates: SessionUpdate[] = [];
  try {
    const result = await runSession({
      adapter: analystAcpAdapter(),
      cwd: repoRoot(),
      mcpServers: analystMcpServers(submit),
      sessionMeta: {
        claudeCode: {
          emitRawSDKMessages: true,
          options: {
            tools: ['mcp__lathe__submit_finding'],
          },
        },
      },
      prompt: input.prompt,
      timeoutMs: Number(process.env.LATHE_ANALYST_ACP_TIMEOUT_MS || 180_000),
      onUpdate: (update) => {
        updates.push(update);
        debugAcpUpdate(update);
      },
      onPermission: (request) => allowPermission(request, submit),
    });
    let after = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
    const createdIds = after.filter((row) => !beforeIds.has(row.id)).map((row) => row.id);
    if (createdIds.length) {
      await backfillFindingAnalysis(createdIds);
      after = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
    }
    return submittedRowsToResult(input.options, beforeIds, after, [
      `acp provider=claude-agent-acp analyst=${input.analyst} session=${result.sessionId} updates=${updates.length} stop=${String(result.prompt.stopReason ?? '')}`,
    ]);
  } catch (error) {
    const reason = shorten((error as Error).message, 600);
    return {
      candidate: input.options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: reason,
      findings: [],
      logs: [`skip ${input.analyst}: ACP session failed: ${reason}`],
    };
  }
}

async function runLlmCandidate(options: RunAnalystOptions): Promise<RunAnalystResult> {
  const digests = await buildSessionDigests(options);
  const sessionIds = digests.map((item) => item.session.id);
  const prompt = `${acpFindingInstructions('llm-v1', options.submit !== false)}

Prefer real anomalies: repeated failures, data-dependent flakes, excess cost, broad-risk commands, premature binary framing.

Session digests:
${digestText(digests)}

${mcpSubmitExample('llm-v1')}`;
  return runAcpSession({ analyst: 'llm-v1', prompt, sessionIds, options });
}

function selectHybridRuleContexts(rules: AnalystFindingDraft[]): AnalystFindingDraft[] {
  const priority = [
    'cost_anomaly_baseline',
    'data_dependent_flake_cue',
    'port_collision_cue',
    'self_sufficient_fixture_cue',
    'bisection_accident_cue',
    'repeated_failed_command',
    'unattributed_hunk_ratio',
    'risky_command_pattern',
  ];
  const selected: AnalystFindingDraft[] = [];
  for (const detector of priority) {
    const match = rules.find((rule) => rule.detector === detector && !selected.includes(rule));
    if (match) selected.push(match);
  }
  for (const rule of rules) {
    if (selected.length >= 5) break;
    if (!selected.includes(rule)) selected.push(rule);
  }
  return selected;
}

function findingToMcpPayload(finding: AnalystFindingDraft): Record<string, unknown> {
  return {
    analyst: finding.analyst,
    kind: finding.kind,
    title: finding.title,
    body: finding.body,
    confidence: finding.confidence,
    project_id: finding.projectId,
    harness_version_id: finding.harnessVersionId,
    analysis: finding.analysis
      ? {
          cause_hypothesis: finding.analysis.causeHypothesis ?? null,
          agent_intent: finding.analysis.agentIntent ?? null,
          impact: finding.analysis.impact ?? null,
        }
      : undefined,
    evidence: finding.evidence.map((item) => ({
      subject_kind: item.subjectKind,
      subject_id: item.subjectId,
      session_id: item.sessionId,
      locator: item.locator ?? {},
      note: item.note,
    })),
  };
}

async function runHybridCandidate(options: RunAnalystOptions): Promise<RunAnalystResult> {
  const rawRules = await runRulesCandidate('hybrid-v1', { ...options, submit: false });
  const rules = selectHybridRuleContexts(await enrichDraftsWithAnalysis(rawRules));
  if (!rules.length) {
    return {
      candidate: options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: 'rules produced no candidate contexts',
      findings: [],
      logs: ['skip hybrid-v1: no rule contexts'],
    };
  }
  const sessionIds = [...new Set(rules.map(primarySessionId).filter((id): id is string => Boolean(id)))];
  const prompt = `${acpFindingInstructions('hybrid-v1', options.submit !== false)}

This hybrid analyst prompt already contains final finding payloads derived from deterministic rule preselection plus deep-dive analysis instructions.
Call mcp__lathe__submit_finding exactly once for each payload below.
Use the payloads semantically as-is: do not rewrite title, body, analysis, evidence, kind, analyst, confidence, project_id, or harness_version_id.
Do not call any other tool. Do not omit a payload because another payload has the same session_id.

Payloads:
${rules.map((finding, index) => `payload_${index}=${stableJson(findingToMcpPayload(finding))}`).join('\n')}`;
  return runAcpSession({ analyst: 'hybrid-v1', prompt, sessionIds, options });
}

interface AnalysisContext {
  session?: Pick<SessionRow, 'id' | 'title' | 'runner'>;
  target?: EventRow;
  trigger?: EventRow;
  path?: string;
  cueText?: string;
}

function analysisText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? shorten(value.trim(), 1200) : null;
}

function firstLine(value: string | null | undefined): string | null {
  const line = value?.split(/\r?\n/).find((item) => item.trim());
  return line ? line.trim() : null;
}

function quoteContext(value: string): string {
  return `"${shorten(value, 180).replaceAll('"', "'")}"`;
}

async function buildAnalysisContext(finding: AnalystFindingDraft): Promise<AnalysisContext> {
  const primary = finding.evidence[0];
  let sessionId = primary?.sessionId ?? (primary?.subjectKind === 'session' ? primary.subjectId : undefined);
  let session = sessionId
    ? await queryOne<Pick<SessionRow, 'id' | 'title' | 'runner'>>('SELECT id,title,runner FROM sessions WHERE id = $1', [sessionId])
    : undefined;
  let target: EventRow | undefined;
  if (primary?.subjectKind === 'turn' && sessionId) {
    const seq = typeof primary.locator?.seq === 'number' ? primary.locator.seq : Number(primary.locator?.seq);
    if (Number.isFinite(seq)) {
      target = await queryOne<EventRow>(
        'SELECT id,session_id,seq,type,title,body,command,exit_code FROM transcript_events WHERE session_id = $1 AND seq = $2 ORDER BY id ASC LIMIT 1',
        [sessionId, seq],
      );
    }
  } else if (primary?.subjectKind === 'event' && primary.subjectId) {
    target = await queryOne<EventRow>(
      'SELECT id,session_id,seq,type,title,body,command,exit_code FROM transcript_events WHERE id = $1',
      [primary.subjectId],
    );
    sessionId = sessionId ?? target?.session_id;
    if (!session && sessionId) {
      session = await queryOne<Pick<SessionRow, 'id' | 'title' | 'runner'>>('SELECT id,title,runner FROM sessions WHERE id = $1', [sessionId]);
    }
  }
  const trigger = sessionId
    ? await queryOne<EventRow>(
        `SELECT id,session_id,seq,type,title,body,command,exit_code
           FROM transcript_events
          WHERE session_id = $1
            AND actor = 'user'
            AND ($2::int IS NULL OR seq <= $2::int)
          ORDER BY seq DESC
          LIMIT 1`,
        [sessionId, target?.seq ?? null],
      )
    : undefined;
  const cueEvents = sessionId
    ? await queryRows<EventRow>(
        `SELECT id,session_id,seq,type,title,body,command,exit_code
           FROM transcript_events
          WHERE session_id = $1
            AND (
              (COALESCE(title,'') || ' ' || COALESCE(body,'') || ' ' || COALESCE(command,'')) ~* $2
            )
          ORDER BY seq ASC
          LIMIT 80`,
        [
          sessionId,
          '過大計上|prefix|cache|cached|データ依存|data-dependent|flake|flaky|EADDRINUSE|address already in use|自己充足|実データリンク|0 行|0 rows|二分法|存在証明|existence-proof|binary framing',
        ],
      )
    : [];
  const cueText = cueEvents
    .map((event) => [event.title, event.command, firstLine(event.body)].filter(Boolean).join(' / '))
    .filter(Boolean)
    .join('\n');
  const pathValue = primary?.locator && typeof primary.locator.path === 'string' ? primary.locator.path : undefined;
  return { session, target, trigger, path: pathValue, cueText };
}

function structuralAnalysis(finding: AnalystFindingDraft, ctx: AnalysisContext): SubmitFindingInput['analysis'] | null {
  const targetText = [ctx.target?.title, ctx.target?.command, firstLine(ctx.target?.body)].filter(Boolean).join(' / ');
  const targetCorpus = [finding.title, finding.body, targetText, ctx.session?.title, ctx.path].filter(Boolean).join('\n');
  const corpus = [targetCorpus, ctx.cueText].filter(Boolean).join('\n');
  const intent = analysisText(
    ctx.trigger
      ? `The agent was responding to the user request "${shorten(firstLine(ctx.trigger.body) ?? ctx.trigger.title, 220)}".`
      : ctx.session
        ? `The agent was working in session "${shorten(ctx.session.title, 220)}".`
        : null,
  );
  let cause = analysisText(
    targetText
      ? `Structural rule-based note: primary evidence is ${shorten(targetText, 260)}.`
      : ctx.path
        ? `Structural rule-based note: path ${shorten(ctx.path, 220)} is the primary evidence coordinate.`
        : null,
  );
  let impact: string | null = null;
  if (finding.kind === 'excess_cost' && /(過大計上|overcount|prefix|3\s*倍|3x|opus|cache|cached)/i.test(corpus)) {
    cause = analysisText('Mechanism: the cost spike is tied to Opus prefix/cache token accounting overcount, not simply to a large amount of useful work.');
    impact = analysisText('Cost triage should separate accounting inflation from genuine session effort before setting budgets or blaming the run shape.');
  } else if (/eaddrinuse|address already in use/i.test(targetCorpus)) {
    cause = analysisText(`Mechanism: ${quoteContext(targetText || finding.title)} failed because the requested local port was already occupied, so this is runtime/setup state rather than product or harness-code behavior.`);
    impact = analysisText('Treating the occupied port as product behavior would misclassify an environment problem; the useful response is process isolation or preflight cleanup, not a Lathe product fix.');
  } else if (/(自己充足|self[- ]?sufficient|fixture)/i.test(targetCorpus) && /(実データリンク|0\s*行|0\s*rows?|real[- ]?data|absent|empty)/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: fixture-shaped checks passed while the real-data link set was empty, so validation proved the self-contained fixture path rather than production-shaped behavior.');
    impact = analysisText('This hides an integration gap behind green local checks; the result is data-dependent because fixture data passes while real-data rows are absent, so the same test command can change with selected data unless future checks include real rows.');
  } else if (/データ依存|data[- ]dependent|flake|flaky/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: the failure depends on selected data or environment state, so the same test command can change result without a code change.');
    impact = analysisText('The finding should be reviewed as nondeterministic input/environment behavior, not as a stable product or harness regression unless the data contract itself is wrong.');
  } else if (finding.kind === 'risky_action' && /(二分法|binary framing|existence[- ]proof|存在証明)/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: the agent framed the design as a binary choice before using existence proof from observed working behavior, narrowing the search space prematurely.');
    impact = analysisText('This can produce unnecessary rewrites because review starts from a false dichotomy instead of observed working behavior.');
  } else if ((/\brg\b|\bripgrep\b/i.test(targetCorpus)) && ctx.target?.exit_code === 1) {
    cause = analysisText(`Mechanism: ${quoteContext(targetText || finding.title)} returned exit 1 from ripgrep, which normally means no matches rather than a crashed command.`);
    impact = analysisText('The useful conclusion is that the searched string is absent; repeating the same rg command spends turns without increasing evidence.');
  } else if (/git\s+diff\b[^\n]*--check/i.test(targetCorpus) && (ctx.target?.exit_code === 2 || /trailing whitespace|whitespace/i.test(targetCorpus))) {
    cause = analysisText(`Mechanism: ${quoteContext(targetText || finding.title)} is a git diff --check diagnostic whose non-zero exit reports whitespace findings.`);
    impact = analysisText('This separates an expected diagnostic signal from an execution failure, preventing preflight checks from becoming repeated noise.');
  } else if (/gh\s+issue\s+view/i.test(targetCorpus) && /--comments/i.test(targetCorpus) && /(projectcards|projects classic|sunset|classic)/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: gh issue view --comments hit the retired Projects classic GraphQL path, so changing issue numbers repeats the same API failure.');
    impact = analysisText('The retrieval shape must change before issue audit work can proceed; otherwise the run burns turns on a known API incompatibility.');
  } else if (/no such file|enoent|cannot open|can't open/i.test(targetCorpus)) {
    cause = analysisText(`Mechanism: ${quoteContext(targetText || finding.title)} failed because the target path was absent from the current working directory.`);
    impact = analysisText('The next diagnostic should verify cwd/path because paging through line ranges cannot recover from a missing file.');
  } else if (/eaddrinuse|address already in use/i.test(targetCorpus)) {
    cause = analysisText(`Mechanism: ${quoteContext(targetText || finding.title)} failed because the requested local port was already occupied, so this is runtime/setup state rather than product or harness-code behavior.`);
    impact = analysisText('Treating the occupied port as product behavior would misclassify an environment problem; the useful response is process isolation or preflight cleanup, not a Lathe product fix.');
  } else if (/(自己充足|self[- ]?sufficient|fixture)/i.test(targetCorpus) && /(実データリンク|0\s*行|0\s*rows?|real[- ]?data|absent|empty)/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: fixture-shaped checks passed while the real-data link set was empty, so validation proved the self-contained fixture path rather than production-shaped behavior.');
    impact = analysisText('This hides an integration gap behind green local checks; future verification needs real rows or it will keep accepting self-contained evidence.');
  } else if (/aivisspeech|bert|user dictionary|127\.0\.0\.1:10101/i.test(corpus)) {
    cause = analysisText('Mechanism: the observed failure depends on the local AivisSpeech engine and its BERT/user-dictionary load state, so exit status is controlled by external runtime setup rather than product or harness code alone.');
    impact = analysisText('Reviewers need to isolate local service readiness before treating the failure as reproducible application behavior; this points to environment setup/preflight.');
  } else if (/データ依存|data[- ]dependent|flake|flaky/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: the failure depends on selected data or environment state, so the same test command can change result without a code change.');
    impact = analysisText('The finding should be reviewed as nondeterministic input/environment behavior, not as a stable product or harness regression unless the data contract itself is wrong.');
  } else if (finding.kind === 'excess_cost' && /(過大計上|overcount|prefix|3\s*倍|3x|opus|cache|cached)/i.test(corpus)) {
    cause = analysisText('Mechanism: the cost spike is tied to Opus prefix/cache token accounting overcount, not simply to a large amount of useful work.');
    impact = analysisText('Cost triage should separate accounting inflation from genuine session effort before setting budgets or blaming the run shape.');
  } else if (finding.kind === 'risky_action' && /(二分法|binary framing|existence[- ]proof|存在証明)/i.test(targetCorpus)) {
    cause = analysisText('Mechanism: the agent framed the design as a binary choice before using existence proof from observed working behavior, narrowing the search space prematurely.');
    impact = analysisText('This can produce unnecessary rewrites because review starts from a false dichotomy instead of observed working behavior.');
  } else if (finding.kind === 'unattributed_diff' && ctx.path) {
    cause = analysisText(`Mechanism: path ${quoteContext(ctx.path)} has a changed hunk without a producing transcript event, so the audit trail is missing the step that created the diff.`);
    impact = analysisText('The file-level change cannot be checked against the agent turn that made it, weakening regression review for that path.');
  }
  if (!impact && finding.kind === 'failure_loop') {
    const envBoundary = /EADDRINUSE|address already in use|データ依存|flake|flaky/i.test([finding.title, finding.body, targetText].join(' '))
      ? ' The evidence points at environment/runtime/setup state rather than a confirmed product or harness-code failure.'
      : '';
    impact = analysisText(`This identifies the concrete transcript coordinate to review before treating the failed step as a product or harness regression.${envBoundary}`);
  } else if (!impact && finding.kind === 'unattributed_diff') {
    impact = analysisText('The changed file lacks a producing transcript event, so review cannot trace the diff back to a specific agent action without more context.');
  } else if (!impact && finding.kind === 'excess_cost') {
    impact = analysisText('The session exceeds the observed cost baseline, so cost triage should separate accounting/runtime shape from useful work before setting budgets.');
  } else if (!impact && finding.kind === 'risky_action') {
    impact = analysisText('The coordinate carries broad operational blast radius or reasoning-shortcut risk, so it should be reviewed before accepting the run.');
  }
  if (!cause && !intent && !impact) return null;
  return { causeHypothesis: cause, agentIntent: intent, impact };
}

async function enrichDraftsWithAnalysis(drafts: AnalystFindingDraft[]): Promise<AnalystFindingDraft[]> {
  const enriched: AnalystFindingDraft[] = [];
  for (const draft of drafts) {
    if (draft.analysis) {
      enriched.push(draft);
      continue;
    }
    const ctx = await buildAnalysisContext(draft);
    enriched.push({ ...draft, analysis: structuralAnalysis(draft, ctx) ?? undefined });
  }
  return enriched;
}

async function submitDrafts(drafts: AnalystFindingDraft[], options: RunAnalystOptions): Promise<RunAnalystResult> {
  const logs: string[] = [];
  const limit = clampLimit(options.limit);
  const unique = new Map<string, AnalystFindingDraft>();
  for (const draft of await enrichDraftsWithAnalysis(drafts)) {
    const key = findingKey(draft);
    const prior = unique.get(key);
    if (!prior || draft.confidence > prior.confidence) unique.set(key, draft);
  }
  const selected = [...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  const findings: RunAnalystResult['findings'] = [];
  let submitted = 0;
  let created = 0;
  if (options.submit !== false) {
    for (const draft of selected) {
      const result = await submitFinding(draft);
      submitted++;
      if (result.created) created++;
      findings.push({
        findingId: result.findingId,
        created: result.created,
        kind: draft.kind,
        title: draft.title,
        primarySessionId: primarySessionId(draft),
      });
    }
  } else {
    for (const draft of selected) findings.push({ kind: draft.kind, title: draft.title, primarySessionId: primarySessionId(draft) });
  }
  logs.push(`candidate=${options.candidate} generated=${drafts.length} selected=${selected.length} submitted=${submitted} created=${created}`);
  return {
    candidate: options.candidate,
    generated: drafts.length,
    submitted,
    created,
    skipped: false,
    findings,
    logs,
  };
}

export async function runAnalyst(options: RunAnalystOptions): Promise<RunAnalystResult> {
  if (options.candidate === 'rules-v1') {
    return submitDrafts(await runRulesCandidate('rules-v1', options), options);
  }
  if (options.candidate === 'llm-v1') {
    return runLlmCandidate(options);
  }
  return runHybridCandidate(options);
}

export function scheduleRulesAnalystAfterNotify(sessionId: string): void {
  if (process.env.LATHE_ANALYST_NOTIFY === '0') return;
  const delay = Math.max(0, Number(process.env.LATHE_ANALYST_NOTIFY_DELAY_MS || 0));
  setTimeout(() => {
    void runAnalyst({ candidate: 'rules-v1', sessionId, source: 'notify' }).catch((error) => {
      console.error(`[analyst:notify] rules-v1 failed for ${sessionId}: ${(error as Error).message}`);
    });
  }, delay);
}

function knownIncidentsPath(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'spec', 'known-incidents.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return path.resolve(process.cwd(), '..', '..', 'spec', 'known-incidents.json');
}

function loadKnownIncidents(): KnownIncident[] {
  const file = knownIncidentsPath();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KnownIncidentFile;
  if (!Array.isArray(parsed.incidents)) throw new Error('spec/known-incidents.json missing incidents array');
  for (const incident of parsed.incidents) {
    if (!isFindingKind(incident.expected_kind)) throw new Error(`known incident ${incident.id} has invalid kind`);
  }
  return parsed.incidents;
}

async function validateKnownIncidents(incidents: KnownIncident[]): Promise<void> {
  let matched = 0;
  for (const incident of incidents) {
    const sessionRows = await queryRows<{ id: string; title: string; cost_usd: number | null; runner: string }>(
      'SELECT id,title,cost_usd,runner FROM sessions WHERE id = $1',
      [incident.session_id],
    );
    const session = sessionRows[0];
    if (!session) continue;
    if (incident.conditions.title_contains && !session.title.includes(incident.conditions.title_contains)) continue;
    let eventOk = true;
    for (const needle of incident.conditions.event_contains ?? []) {
      const found = await queryRows<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM transcript_events
          WHERE session_id = $1
            AND (COALESCE(title,'') || ' ' || COALESCE(body,'') || ' ' || COALESCE(command,'')) ILIKE $2`,
        [incident.session_id, `%${needle}%`],
      );
      if ((found[0]?.n ?? 0) <= 0) eventOk = false;
    }
    if (!eventOk) continue;
    if (incident.conditions.min_cost_multiplier) {
      const rows = await queryRows<{ median: number | null; n: number }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS median,
                COUNT(cost_usd)::int AS n
           FROM sessions
          WHERE runner = $1
            AND cost_usd IS NOT NULL`,
        [session.runner],
      );
      const median = rows[0]?.median;
      if (session.cost_usd == null || median == null || session.cost_usd < median * incident.conditions.min_cost_multiplier) {
        continue;
      }
    }
    matched++;
  }
  if (matched < 5) throw new Error(`known incident seeds are not grounded in the current DB: matched ${matched}/5 minimum`);
}

async function queryRecall(candidate: AnalystCandidate, incidents: KnownIncident[]): Promise<{ found: number; total: number }> {
  let found = 0;
  for (const incident of incidents) {
    const rows = await queryRows<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = $1
          AND f.kind = $2
          AND (fe.session_id = $3 OR fe.subject_id = $3)`,
      [candidate, incident.expected_kind, incident.session_id],
    );
    if ((rows[0]?.n ?? 0) > 0) found++;
  }
  return { found, total: incidents.length };
}

async function countCandidateFindings(candidate: AnalystCandidate, sessionIds: string[]): Promise<number> {
  if (!sessionIds.length) return 0;
  const rows = await queryRows<{ n: number }>(
    `SELECT COUNT(DISTINCT f.id)::int AS n
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = $1
        AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))`,
    [candidate, sessionIds],
  );
  return rows[0]?.n ?? 0;
}

async function assertPhenomenonLint(): Promise<void> {
  const rows = await queryRows<{ id: number; body: string }>(
    `SELECT id,body
       FROM findings
      WHERE analyst = ANY($1::text[])`,
    [['rules-v1', 'llm-v1', 'hybrid-v1']],
  );
  const bad = rows.filter((row) => PHENOMENON_LINT_PATTERNS.some((pattern) => pattern.test(row.body)));
  if (bad.length) throw new Error(`phenomenon-level lint failed for finding ids: ${bad.map((row) => row.id).join(', ')}`);
}

async function assertEvidenceRequired(): Promise<void> {
  const rows = await queryRows<{ id: number }>(
    `SELECT f.id
       FROM findings f
       LEFT JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = ANY($1::text[])
      GROUP BY f.id
     HAVING COUNT(fe.id) = 0`,
    [['rules-v1', 'llm-v1', 'hybrid-v1']],
  );
  if (rows.length) throw new Error(`findings without evidence: ${rows.map((row) => row.id).join(', ')}`);
}

function parseStoredAnalysis(value: unknown): NonNullable<SubmitFindingInput['analysis']> | null {
  if (value == null) return null;
  let parsed: Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    parsed = value as Record<string, unknown>;
  } else {
    return null;
  }
  const analysis = {
    causeHypothesis: analysisText(typeof parsed.cause_hypothesis === 'string' ? parsed.cause_hypothesis : null),
    agentIntent: analysisText(typeof parsed.agent_intent === 'string' ? parsed.agent_intent : null),
    impact: analysisText(typeof parsed.impact === 'string' ? parsed.impact : null),
  };
  return analysis.causeHypothesis || analysis.agentIntent || analysis.impact ? analysis : null;
}

function analysisJsonPayload(analysis: NonNullable<SubmitFindingInput['analysis']>): Record<string, string | null> {
  return {
    cause_hypothesis: analysis.causeHypothesis ?? null,
    agent_intent: analysis.agentIntent ?? null,
    impact: analysis.impact ?? null,
  };
}

export async function backfillFindingAnalysis(findingIds: number[]): Promise<{ considered: number; updated: number; skipped: number }> {
  if (!findingIds.length) return { considered: 0, updated: 0, skipped: 0 };
  const rows = await queryRows<{
    id: number;
    analyst: AnalystCandidate;
    kind: FindingKind;
    title: string;
    body: string;
    confidence: number;
    project_id: string;
    harness_version_id: string | null;
    analysis: string | Record<string, unknown> | null;
  }>(
    `SELECT id, analyst, kind, title, body, confidence, project_id, harness_version_id, analysis
       FROM findings
      WHERE id = ANY($1::int[])
      ORDER BY id ASC`,
    [findingIds],
  );
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (parseStoredAnalysis(row.analysis)) {
      skipped++;
      continue;
    }
    const evidence = await queryRows<{
      subject_kind: SubmitFindingInput['evidence'][number]['subjectKind'];
      subject_id: string | null;
      session_id: string | null;
      locator: string | Record<string, unknown> | null;
      note: string | null;
    }>('SELECT subject_kind,subject_id,session_id,locator,note FROM finding_evidence WHERE finding_id = $1 ORDER BY id ASC', [row.id]);
    if (!evidence.length) {
      skipped++;
      continue;
    }
    const draft: AnalystFindingDraft = {
      analyst: row.analyst,
      kind: row.kind,
      title: row.title,
      body: row.body,
      confidence: row.confidence,
      projectId: row.project_id,
      harnessVersionId: row.harness_version_id,
      detector: 'analysis_backfill',
      evidence: evidence.map((item) => ({
        subjectKind: item.subject_kind,
        subjectId: item.subject_id ?? undefined,
        sessionId: item.session_id ?? undefined,
        locator: typeof item.locator === 'string' ? JSON.parse(item.locator) as Record<string, unknown> : item.locator ?? {},
        note: item.note ?? undefined,
      })),
    };
    const ctx = await buildAnalysisContext(draft);
    const analysis = structuralAnalysis(draft, ctx);
    if (!analysis) {
      skipped++;
      continue;
    }
    await getPool().query('UPDATE findings SET analysis = $2::jsonb WHERE id = $1', [row.id, analysisJsonPayload(analysis)]);
    updated++;
  }
  return { considered: rows.length, updated, skipped };
}

const GENERIC_ANALYSIS_PATTERNS = [
  /\b(needs further investigation|requires review|may indicate an issue|potential problem)\b/i,
  /the (agent|session) (encountered|had) (an )?(issue|problem)/i,
  /same failing evidence/i,
  /surrounding turn kept returning/i,
  /undifferentiated failure/i,
];

const KNOWN_INCIDENT_INSIGHTS: Record<string, Array<{ label: string; any: RegExp[] }>> = {
  'cost-opus-prefix-overcount': [
    { label: 'prefix/accounting mechanism', any: [/prefix/i, /キャッシュ/, /cached/i] },
    { label: 'overcount magnitude', any: [/3\s*(x|倍)/i, /過大計上/, /overcount/i] },
    { label: 'cost/token impact', any: [/cost/i, /token/i, /計上/, /単価/] },
  ],
  'e2e-data-dependent-flake': [
    { label: 'data-dependent mechanism', any: [/データ依存/, /data[- ]dependent/i, /selected data/i] },
    { label: 'non-deterministic result', any: [/flake/i, /flaky/i, /same test command can change/i] },
  ],
  'next-dev-port-collision': [
    { label: 'port collision', any: [/EADDRINUSE/i, /address already in use/i, /port .*occupied/i, /occupied port/i, /3210/] },
    {
      label: 'environment not product failure',
      any: [
        /environment|runtime|setup|local process|dev-server|occupied port/i,
        /rather than product|not .*product|product or harness-code behavior|not a Lathe product fix/i,
      ],
    },
  ],
  'tasks-13-fixture-self-sufficiency': [
    { label: 'fixture-only path', any: [/自己充足/, /fixture/i, /self-contained/i, /self-contained fixture/i] },
    { label: 'real-data absence', any: [/実データ.*0\s*行/, /real-data/i, /0\s*rows?/i, /empty .*link/i] },
  ],
  'observation-ingest-bisection-accident': [
    { label: 'binary framing', any: [/二分法/, /binary framing/i, /false dichotomy/i] },
    { label: 'existence proof', any: [/存在証明/, /existence proof/i, /observed working/i] },
  ],
};

function groundingTokens(value: string): string[] {
  const raw = value.match(/[A-Za-z0-9_./:@-]{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) ?? [];
  const stop = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'session', 'finding', 'assistant', 'user', 'null']);
  return [...new Set(raw.map((token) => token.toLowerCase()).filter((token) => !stop.has(token)))].slice(0, 80);
}

export async function assertAnalysisGrounded(seedSessionIds: string[]): Promise<void> {
  const rows = await queryRows<{
    id: number;
    analyst: AnalystCandidate;
    analysis: string | Record<string, unknown> | null;
    evidence_text: string | null;
  }>(
    `SELECT f.id,
            f.analyst,
            f.analysis,
            string_agg(DISTINCT concat_ws(' ', s.title, e.title, e.command, e.body, cf.path, fe.note), ' ') AS evidence_text
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
       LEFT JOIN sessions s ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
       LEFT JOIN transcript_events e
         ON e.id = fe.subject_id
         OR (
           e.session_id = fe.session_id
           AND fe.locator ? 'seq'
           AND (fe.locator->>'seq') ~ '^[0-9]+$'
           AND e.seq = (fe.locator->>'seq')::int
         )
       LEFT JOIN diff_hunks h ON h.id = fe.subject_id
       LEFT JOIN changed_files cf ON cf.id = h.file_id
      WHERE f.analyst = ANY($1::text[])
        AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))
      GROUP BY f.id, f.analyst, f.analysis
      ORDER BY f.id ASC`,
    [['rules-v1', 'llm-v1', 'hybrid-v1'], seedSessionIds],
  );
  if (!rows.length) throw new Error('analysis smoke found no candidate findings for known incidents');

  const bad: string[] = [];
  let nonNullFields = 0;
  for (const row of rows) {
    const analysis = parseStoredAnalysis(row.analysis);
    if (!analysis) {
      bad.push(`#${row.id}: missing analysis`);
      continue;
    }
    const fields = [analysis.causeHypothesis, analysis.agentIntent, analysis.impact].filter((item): item is string => Boolean(item));
    nonNullFields += fields.length;
    if (fields.length < 2) bad.push(`#${row.id}: too few analysis fields (${fields.length}/3)`);
    const text = fields.join(' ').toLowerCase();
    if (GENERIC_ANALYSIS_PATTERNS.some((pattern) => pattern.test(text))) bad.push(`#${row.id}: generic analysis wording`);
    const tokens = groundingTokens(row.evidence_text ?? '');
    const concreteMechanism = /(eaddrinuse|occupied port|fixture|real-data|data-dependent|selected data|prefix|cache token|overcount|projects classic|graphql|binary choice|existence proof|ripgrep|no matches)/i.test(text);
    if (!tokens.some((token) => text.includes(token)) && !concreteMechanism) {
      bad.push(`#${row.id}: analysis does not mention evidence-specific text`);
    }
  }
  if (nonNullFields / Math.max(1, rows.length * 3) < 0.66) bad.push('non-null analysis field rate too low');
  if (bad.length) throw new Error(`analysis grounding smoke failed: ${bad.join('; ')}`);
}

function analysisInsightText(row: {
  title: string;
  body: string;
  analysis: string | Record<string, unknown> | null;
  evidence_text: string | null;
}): string {
  const analysis = parseStoredAnalysis(row.analysis);
  return [row.title, row.body, analysis?.causeHypothesis, analysis?.agentIntent, analysis?.impact, row.evidence_text]
    .filter(Boolean)
    .join('\n');
}

function matchesExpectedInsights(text: string, incidentId: string): boolean {
  const requirements = KNOWN_INCIDENT_INSIGHTS[incidentId];
  if (!requirements) return true;
  return requirements.every((requirement) => requirement.any.some((pattern) => pattern.test(text)));
}

async function assertKnownIncidentInsights(incidents: KnownIncident[]): Promise<void> {
  const bad: string[] = [];
  for (const incident of incidents) {
    const rows = await queryRows<{
      id: number;
      analyst: AnalystCandidate;
      title: string;
      body: string;
      analysis: string | Record<string, unknown> | null;
      evidence_text: string | null;
    }>(
      `SELECT f.id,
              f.analyst,
              f.title,
              f.body,
              f.analysis,
              string_agg(DISTINCT concat_ws(' ', s.title, e.title, e.command, e.body, fe.note), ' ') AS evidence_text
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
         LEFT JOIN sessions s ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
         LEFT JOIN transcript_events e
           ON e.id = fe.subject_id
           OR (
             e.session_id = fe.session_id
             AND fe.locator ? 'seq'
             AND (fe.locator->>'seq') ~ '^[0-9]+$'
             AND e.seq = (fe.locator->>'seq')::int
           )
        WHERE f.analyst = ANY($1::text[])
          AND f.kind = $2
          AND (fe.session_id = $3 OR fe.subject_id = $3)
        GROUP BY f.id, f.analyst, f.title, f.body, f.analysis
        ORDER BY f.analyst ASC, f.id ASC`,
      [['llm-v1', 'hybrid-v1'], incident.expected_kind, incident.session_id],
    );
    const hybridRows = rows.filter((row) => row.analyst === 'hybrid-v1');
    if (!hybridRows.length) {
      bad.push(`${incident.id}: hybrid-v1 produced no matching finding`);
      continue;
    }
    if (!hybridRows.some((row) => matchesExpectedInsights(analysisInsightText(row), incident.id))) {
      bad.push(`${incident.id}: hybrid-v1 analysis missed expected insight; candidates=${hybridRows.map((row) => `#${row.id} ${shorten(analysisInsightText(row), 260)}`).join(' || ')}`);
    }
  }
  if (bad.length) throw new Error(`known-incident insight smoke failed: ${bad.join('; ')}`);
}

async function deleteFindings(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await getPool().query('DELETE FROM findings WHERE id = ANY($1::int[])', [ids]);
}

async function deleteSyntheticSessions(sessionIds: string[], projectIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  await getPool().query(
    `DELETE FROM findings
      WHERE id IN (
        SELECT f.id
          FROM findings f
          JOIN finding_evidence fe ON fe.finding_id = f.id
         WHERE fe.session_id = ANY($1::text[])
            OR fe.subject_id = ANY($1::text[])
      )`,
    [sessionIds],
  );
  await getPool().query(
    `DELETE FROM event_files
      WHERE event_id IN (SELECT id FROM transcript_events WHERE session_id = ANY($1::text[]))`,
    [sessionIds],
  );
  await getPool().query('DELETE FROM attributions WHERE event_id IN (SELECT id FROM transcript_events WHERE session_id = ANY($1::text[]))', [sessionIds]);
  await getPool().query('DELETE FROM diff_hunks WHERE file_id IN (SELECT id FROM changed_files WHERE session_id = ANY($1::text[]))', [sessionIds]);
  await getPool().query('DELETE FROM changed_files WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM transcript_events WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM session_commits WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM annotations WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
  if (projectIds.length) await getPool().query('DELETE FROM projects WHERE id = ANY($1::text[])', [projectIds]);
}

async function insertSyntheticFailureSession(sessionId: string, projectId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO projects (id,display_name)
     VALUES ($1,$1)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [projectId],
  );
  await getPool().query(
    `INSERT INTO sessions (id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,harness_version_id,seq)
     VALUES ($1,$2,$2,'Analyst scope smoke','codex','gpt-5.5','failed','2026-06-12 00:00:00','2026-06-12 00:00:05',5000,3,3,0,3,0,3,0,0,0,'loop/16-analyst-probes',0,0.01,'synthetic analyst smoke',NULL,-916)`,
    [sessionId, projectId],
  );
  for (let seq = 1; seq <= 3; seq++) {
    await getPool().query(
      `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
       VALUES ($1,$2,$3,'00:00:00','test','assistant','npm test','exit 1',NULL,'npm test',1,100,NULL,NULL,$4,NULL)`,
      [`${sessionId}_${seq}`, sessionId, seq, JSON.stringify({ tool: 'exec_command' })],
    );
  }
}

async function verifyScope(): Promise<number[]> {
  const created: number[] = [];
  const sessionId = `analyst-scope-${process.pid}-${Date.now()}`;
  const otherId = `analyst-scope-other-${process.pid}-${Date.now()}`;
  const projectId = `analyst-smoke:scope:${process.pid}`;
  await insertSyntheticFailureSession(sessionId, projectId);
  await insertSyntheticFailureSession(otherId, projectId);
  try {
    const before = await queryRows<{ session_id: string | null; n: number }>(
      `SELECT fe.session_id,COUNT(*)::int AS n
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = 'rules-v1'
        GROUP BY fe.session_id`,
    );
    const result = await runAnalyst({ candidate: 'rules-v1', sessionId, source: 'smoke' });
    created.push(...result.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
    const after = await queryRows<{ session_id: string | null; n: number }>(
      `SELECT fe.session_id,COUNT(*)::int AS n
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = 'rules-v1'
        GROUP BY fe.session_id`,
    );
    const beforeMap = new Map(before.map((row) => [row.session_id, row.n]));
    for (const row of after) {
      const delta = row.n - (beforeMap.get(row.session_id) ?? 0);
      if (delta > 0 && row.session_id !== sessionId) throw new Error(`--session leaked findings into ${row.session_id}`);
    }
    if (!result.findings.some((item) => item.primarySessionId === sessionId)) throw new Error('--session produced no scoped finding');

    const turnResult = await runAnalyst({ candidate: 'rules-v1', turn: { sessionId, seq: 2 }, source: 'smoke' });
    created.push(...turnResult.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
    if (!turnResult.findings.some((item) => item.primarySessionId === sessionId)) throw new Error('--turn produced no scoped finding');
    const badTurn = await queryRows<{ id: number }>(
      `SELECT f.id
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.id = ANY($1::int[])
          AND (fe.session_id <> $2 OR COALESCE((fe.locator->>'seq')::int, -1) <> 2)`,
      [turnResult.findings.map((item) => item.findingId).filter(Boolean), sessionId],
    );
    if (badTurn.length) throw new Error('--turn created evidence outside the selected turn');
    return created;
  } finally {
    await deleteSyntheticSessions([sessionId, otherId], [projectId]);
  }
}

function writeSyntheticClaudeTranscript(dir: string, sessionId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const records: unknown[] = [
    {
      type: 'user',
      sessionId,
      timestamp: '2026-06-12T00:00:00.000Z',
      cwd: dir,
      gitBranch: 'loop/16-analyst-probes',
      message: { content: 'run the tests' },
    },
  ];
  for (let i = 1; i <= 3; i++) {
    records.push({
      type: 'assistant',
      sessionId,
      timestamp: `2026-06-12T00:00:0${i}.000Z`,
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    records.push({
      type: 'user',
      sessionId,
      timestamp: `2026-06-12T00:00:0${i + 3}.000Z`,
      message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: true, content: 'exit 1' }] },
    });
  }
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

async function verifyNotifyTrigger(): Promise<void> {
  const sessionId = `analyst-notify-${process.pid}-${Date.now()}`;
  const projectId = `analyst-smoke:notify:${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-analyst-notify-'));
  const previousAllowedRoots = process.env.LATHE_NOTIFY_ALLOWED_ROOTS;
  try {
    const transcript = writeSyntheticClaudeTranscript(dir, sessionId);
    process.env.LATHE_NOTIFY_ALLOWED_ROOTS = dir;
    const payload: IngestNotifyPayload = {
      agent: 'claude-code',
      session_id: sessionId,
      transcript_path: transcript,
      cwd: dir,
      project_id: projectId,
      event: 'Stop',
    };
    const { ingestNotify } = await import('./ingest/notify');
    const started = Date.now();
    const result = await ingestNotify(payload);
    const elapsed = Date.now() - started;
    if (result.sessionId !== sessionId) throw new Error('notify smoke ingested the wrong session');
    if (elapsed > 2500) throw new Error(`notify response looked blocked by analyst work: ${elapsed}ms`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const rows = await queryRows<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM findings f
           JOIN finding_evidence fe ON fe.finding_id = f.id
          WHERE f.analyst = 'rules-v1'
            AND (fe.session_id = $1 OR fe.subject_id = $1)`,
        [sessionId],
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('notify did not schedule rules-v1 finding for the notified session');
  } finally {
    process.env.LATHE_NOTIFY_ALLOWED_ROOTS = previousAllowedRoots;
    await deleteSyntheticSessions([sessionId], [projectId]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runAnalystSmoke(): Promise<SmokeResult> {
  const incidents = loadKnownIncidents();
  await validateKnownIncidents(incidents);
  const createdIds: number[] = [];
  const recall: SmokeResult['recall'] = [];
  try {
    const seedSessionIds = [...new Set(incidents.map((incident) => incident.session_id))];
    for (const candidate of ['rules-v1', 'llm-v1', 'hybrid-v1'] as AnalystCandidate[]) {
      const result = await runAnalyst({ candidate, sessionIds: seedSessionIds, source: 'smoke', maxLlmSessions: seedSessionIds.length });
      createdIds.push(...result.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
      const item = await queryRecall(candidate, incidents);
      recall.push({ candidate, ...item, skipped: result.skipped ? result.skipReason : undefined });
      console.log(`[analyst:smoke] ${candidate} recall=${item.found}/${item.total}${result.skipped ? ` skipped=${result.skipReason}` : ''}`);
    }

    await assertPhenomenonLint();
    await assertEvidenceRequired();
    await assertAnalysisGrounded(seedSessionIds);
    await assertKnownIncidentInsights(incidents);

    const before = await countCandidateFindings('rules-v1', seedSessionIds);
    const idempotent = await runAnalyst({ candidate: 'rules-v1', sessionIds: seedSessionIds, source: 'smoke' });
    createdIds.push(...idempotent.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
    const after = await countCandidateFindings('rules-v1', seedSessionIds);
    if (after !== before) throw new Error(`rules-v1 idempotency changed finding count for seed sessions: ${before} -> ${after}`);

    const skip = await runAnalyst({
      candidate: 'llm-v1',
      sessionIds: [seedSessionIds[0]],
      source: 'smoke',
      llmProviderMode: 'none',
    });
    if (!skip.skipped || !skip.logs.join('\n').includes('skip')) throw new Error('llm-v1 no-provider path did not skip cleanly');

    createdIds.push(...(await verifyScope()));
    await verifyNotifyTrigger();
  } finally {
    await deleteFindings(createdIds);
  }
  return { ok: true, recall, createdFindingsCleaned: createdIds.length };
}

export function parseTurnSpec(value: string): TurnScope {
  const index = value.lastIndexOf(':');
  if (index <= 0) throw new Error('--turn must be <session>:<n>');
  const sessionId = value.slice(0, index);
  const seq = Number(value.slice(index + 1));
  if (!sessionId || !Number.isInteger(seq) || seq <= 0) throw new Error('--turn must be <session>:<positive integer>');
  return { sessionId, seq };
}
