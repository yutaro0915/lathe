import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
export type LlmProviderMode = 'auto' | 'none' | 'claude-cli' | 'anthropic-api';

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

    const fixtureEvents = sessionEvents.filter((event) => SELF_SUFFICIENT_FIXTURE.test(eventText(event)));
    for (const event of fixtureEvents.slice(0, 2)) {
      out.push(
        makeFinding({
          analyst,
          detector: 'self_sufficient_fixture_cue',
          kind: 'failure_loop',
          title: `Fixture-only validation cue in ${session.title}`,
          body: `The transcript describes a validation path that passed fixture-like checks while real data behavior diverged. The phenomenon is a self-contained verification loop that did not cover the observed production-shaped data.`,
          confidence: 0.9,
          projectId: session.project_id,
          harnessVersionId: session.harness_version_id,
          evidence: [turnEvidence(sessionId, event.seq, 'fixture/self-sufficiency cue')],
        }),
      );
    }
    const portEvents = sessionEvents.filter((event) => /EADDRINUSE|address already in use/i.test(eventText(event)));
    for (const event of portEvents.slice(0, 2)) {
      out.push(
        makeFinding({
          analyst,
          detector: 'port_collision_cue',
          kind: 'failure_loop',
          title: `Port collision cue in ${session.title}`,
          body: `The transcript shows a local server failure caused by EADDRINUSE or an already occupied address. The phenomenon is an environment/process collision rather than a stable application failure.`,
          confidence: 0.9,
          projectId: session.project_id,
          harnessVersionId: session.harness_version_id,
          evidence: [turnEvidence(sessionId, event.seq, 'port collision cue')],
        }),
      );
    }
    const dataEvents = sessionEvents.filter((event) => {
      const text = eventText(event);
      return DATA_DEPENDENT_FLAKE.test(text) && !SELF_SUFFICIENT_FIXTURE.test(text) && !/EADDRINUSE|address already in use/i.test(text);
    });
    for (const event of dataEvents.slice(0, 4)) {
      const text = eventText(event);
      out.push(
        makeFinding({
          analyst,
          detector: 'data_dependent_flake_cue',
          kind: 'failure_loop',
          title: `Data-dependent failure cue in ${session.title}`,
          body: `The transcript calls out a failure as data-dependent or environment-dependent. The phenomenon is a test result that changed with the selected data or occupied runtime resource, not a stable product behavior.`,
          confidence: 0.88,
          projectId: session.project_id,
          harnessVersionId: session.harness_version_id,
          evidence: [turnEvidence(sessionId, event.seq, 'data-dependent failure cue')],
        }),
      );
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

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0;
}

function selectLlmProvider(mode: LlmProviderMode = 'auto'): { kind: 'claude-cli' | 'anthropic-api' | 'none'; reason?: string } {
  if (mode === 'none') return { kind: 'none', reason: 'forced no-provider mode' };
  if (mode === 'claude-cli') {
    return commandAvailable('claude') ? { kind: 'claude-cli' } : { kind: 'none', reason: 'claude CLI not found' };
  }
  if (mode === 'anthropic-api') {
    return process.env.ANTHROPIC_API_KEY ? { kind: 'anthropic-api' } : { kind: 'none', reason: 'ANTHROPIC_API_KEY not set' };
  }
  if (process.env.LATHE_ANALYST_DISABLE_CLAUDE_CLI !== '1' && commandAvailable('claude')) return { kind: 'claude-cli' };
  if (process.env.ANTHROPIC_API_KEY) return { kind: 'anthropic-api' };
  return { kind: 'none', reason: 'no claude CLI or ANTHROPIC_API_KEY available' };
}

function llmFindingSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...FINDING_KINDS] },
            title: { type: 'string' },
            body: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            session_id: { type: 'string' },
            turn_seq: { type: 'number' },
            analysis: analysisJsonSchema(),
          },
          required: ['kind', 'title', 'body', 'confidence', 'session_id', 'analysis'],
        },
      },
    },
    required: ['findings'],
  };
}

function hybridFindingSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source_index: { type: 'number' },
            title: { type: 'string' },
            body: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            analysis: analysisJsonSchema(),
          },
          required: ['source_index', 'title', 'body', 'confidence', 'analysis'],
        },
      },
    },
    required: ['findings'],
  };
}

function analysisJsonSchema() {
  const nullableString = { anyOf: [{ type: 'string', maxLength: 1200 }, { type: 'null' }] };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      cause_hypothesis: nullableString,
      agent_intent: nullableString,
      impact: nullableString,
    },
    required: ['cause_hypothesis', 'agent_intent', 'impact'],
  };
}

function extractJsonPayload(stdout: string): unknown {
  const parsed = JSON.parse(stdout);
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (record.structured_output && typeof record.structured_output === 'object') return record.structured_output;
    if (typeof record.result === 'string') {
      try {
        return JSON.parse(record.result);
      } catch {
        return record;
      }
    }
    if (record.result && typeof record.result === 'object') return record.result;
  }
  return parsed;
}

async function callLlmJson(
  prompt: string,
  schema: Record<string, unknown>,
  analyst: AnalystCandidate,
  mode: LlmProviderMode | undefined,
): Promise<{ skipped?: string; value?: unknown; log: string }> {
  const provider = selectLlmProvider(mode);
  if (provider.kind === 'none') {
    return { skipped: provider.reason ?? 'no provider', log: `skip ${analyst}: ${provider.reason ?? 'no provider'}` };
  }

  const callAnthropicApi = async (): Promise<{ skipped?: string; value?: unknown; log: string }> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.LATHE_ANALYST_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1600,
        system: `${INTERNAL_ANALYST_TAG}=1 candidate=${analyst}; return only JSON matching the requested schema.`,
        messages: [{ role: 'user', content: `${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}` }],
      }),
    });
    if (!response.ok) {
      return { skipped: `Anthropic API ${response.status}`, log: `skip ${analyst}: Anthropic API ${response.status}` };
    }
    const payload = (await response.json()) as Record<string, any>;
    const text = payload.content?.find((item: Record<string, unknown>) => item.type === 'text')?.text;
    if (typeof text !== 'string') return { skipped: 'Anthropic API response had no text', log: `skip ${analyst}: empty API response` };
    try {
      return { value: JSON.parse(text), log: `llm provider=anthropic-api analyst=${analyst}` };
    } catch (error) {
      return { skipped: (error as Error).message, log: `skip ${analyst}: invalid API JSON` };
    }
  };

  if (provider.kind === 'claude-cli') {
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--model',
        process.env.LATHE_ANALYST_CLAUDE_MODEL || 'sonnet',
        '--effort',
        process.env.LATHE_ANALYST_CLAUDE_EFFORT || 'low',
        '--max-budget-usd',
        process.env.LATHE_ANALYST_MAX_BUDGET_USD || '0.25',
        '--tools',
        '',
        '--disable-slash-commands',
        '--name',
        `${INTERNAL_ANALYST_TAG}-${analyst}`,
        '--system-prompt',
        `${INTERNAL_ANALYST_TAG}=1 candidate=${analyst}; return only JSON that matches the schema. Produce phenomenon-level Lathe findings only. Never prescribe harness file edits.`,
        prompt,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: Number(process.env.LATHE_ANALYST_LLM_TIMEOUT_MS || 120_000),
        env: {
          ...process.env,
          LATHE_INTERNAL_ANALYST: analyst,
          LATHE_INTERNAL_ANALYST_TAG: INTERNAL_ANALYST_TAG,
        },
      },
    );
    if (result.status !== 0) {
      const reason = shorten(result.stderr || result.stdout || `claude exited ${result.status}`, 600);
      if (mode !== 'claude-cli' && process.env.ANTHROPIC_API_KEY) {
        const fallback = await callAnthropicApi();
        return {
          ...fallback,
          log: `llm provider=claude-cli failed; ${fallback.log}`,
        };
      }
      return { skipped: reason, log: `skip ${analyst}: claude CLI failed: ${reason}` };
    }
    try {
      return { value: extractJsonPayload(result.stdout), log: `llm provider=claude-cli analyst=${analyst}` };
    } catch (error) {
      if (mode !== 'claude-cli' && process.env.ANTHROPIC_API_KEY) {
        const fallback = await callAnthropicApi();
        return {
          ...fallback,
          log: `llm provider=claude-cli invalid-json; ${fallback.log}`,
        };
      }
      return { skipped: (error as Error).message, log: `skip ${analyst}: invalid claude JSON` };
    }
  }

  return callAnthropicApi();
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

function analysisTextField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? shorten(value.trim(), 1200) : null;
}

function analysisFromRecord(row: Record<string, unknown>): SubmitFindingInput['analysis'] | null {
  const raw = row.analysis;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const analysis = raw as Record<string, unknown>;
  const causeHypothesis = analysisTextField(analysis.cause_hypothesis);
  const agentIntent = analysisTextField(analysis.agent_intent);
  const impact = analysisTextField(analysis.impact);
  return causeHypothesis || agentIntent || impact ? { causeHypothesis, agentIntent, impact } : null;
}

function mapLlmFindings(
  value: unknown,
  analyst: AnalystCandidate,
  sessions: Map<string, SessionRow>,
): AnalystFindingDraft[] {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const findings = Array.isArray(record.findings) ? record.findings : [];
  const out: AnalystFindingDraft[] = [];
  for (const item of findings) {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const kind = cleanText(row.kind);
    const sessionId = cleanText(row.session_id);
    const session = sessions.get(sessionId);
    if (!isFindingKind(kind) || !session) continue;
    const turnSeq = typeof row.turn_seq === 'number' && Number.isFinite(row.turn_seq) ? Math.trunc(row.turn_seq) : undefined;
    const evidence = turnSeq ? [turnEvidence(sessionId, turnSeq, 'LLM-selected turn')] : [sessionEvidence(sessionId, 'LLM-selected session')];
    out.push(
      makeFinding({
        analyst,
        detector: 'llm_session_bundle',
        kind,
        title: cleanText(row.title, `${kind} in ${session.title}`),
        body: cleanText(row.body, 'The model reported an observable session-level phenomenon.'),
        confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        analysis: analysisFromRecord(row),
        evidence,
      }),
    );
  }
  return out;
}

async function runLlmCandidate(options: RunAnalystOptions): Promise<{ drafts: AnalystFindingDraft[]; skipped?: string; log: string }> {
  const digests = await buildSessionDigests(options);
  const sessions = new Map(digests.map((item) => [item.session.id, item.session]));
  const prompt = `Read these Lathe session digests and return 1 to 5 phenomenon-level findings.

Constraints:
- Allowed kind values: failure_loop, unattributed_diff, excess_cost, risky_action.
- Describe observable behavior only.
- Do not instruct anyone to edit CLAUDE.md, AGENTS.md, hooks, or harness files.
- Evidence must point to one provided session_id and optionally a turn seq.
- Prefer real anomalies: repeated failures, data-dependent flake, excess cost, broad-risk commands, premature binary framing.
- Every finding must include analysis with cause_hypothesis, agent_intent, and impact.
- cause_hypothesis must name the concrete failure mechanism visible in the transcript, not restate the kind.
  Good examples: "rg exit 1 means no matches, so the agent treated a negative search result as a failed command"; "git diff --check exit 2 reports whitespace findings"; "EADDRINUSE means the port was already occupied"; "fixture data passed while real links were 0 rows".
  Bad examples: "the same failing evidence repeated", "the session encountered an issue", "needs further investigation".
- If the transcript does not reveal a concrete mechanism, set cause_hypothesis to null instead of inventing one.
- agent_intent must cite the user request or task being pursued.
- impact must explain why that specific mechanism matters for reviewing this run.

Session digests:
${digestText(digests)}`;
  const response = await callLlmJson(prompt, llmFindingSchema(), 'llm-v1', options.llmProviderMode);
  if (response.skipped) return { drafts: [], skipped: response.skipped, log: response.log };
  if (process.env.LATHE_ANALYST_DEBUG_LLM === '1') {
    console.error(`[analyst:debug] llm-v1 raw=${JSON.stringify(response.value)}`);
  }
  const raw = response.value && typeof response.value === 'object' && Array.isArray((response.value as Record<string, unknown>).findings)
    ? ((response.value as Record<string, unknown>).findings as unknown[]).length
    : 0;
  const drafts = mapLlmFindings(response.value, 'llm-v1', sessions);
  return { drafts, log: `${response.log} raw=${raw} mapped=${drafts.length}` };
}

function hybridSourcePriority(finding: AnalystFindingDraft): number {
  if (finding.detector === 'cost_anomaly_baseline') return 0;
  if (finding.detector === 'port_collision_cue') return 1;
  if (finding.detector === 'data_dependent_flake_cue') return 2;
  if (finding.detector === 'self_sufficient_fixture_cue') return 3;
  if (finding.detector === 'bisection_accident_cue') return 4;
  if (finding.detector === 'risky_command_pattern') return 5;
  if (finding.detector === 'repeated_failed_command') return 6;
  if (finding.detector === 'failed_turn') return 7;
  return 9;
}

function selectHybridSources(findings: AnalystFindingDraft[]): AnalystFindingDraft[] {
  return [...findings].sort((a, b) => {
    const byPriority = hybridSourcePriority(a) - hybridSourcePriority(b);
    if (byPriority !== 0) return byPriority;
    return b.confidence - a.confidence;
  });
}

async function runHybridCandidate(options: RunAnalystOptions): Promise<{ drafts: AnalystFindingDraft[]; skipped?: string; log: string }> {
  const ruleCandidates = await runRulesCandidate('hybrid-v1', { ...options, submit: false });
  const rules = selectHybridSources(ruleCandidates).slice(0, 12);
  if (!rules.length) return { drafts: [], skipped: 'rules produced no candidate contexts', log: 'skip hybrid-v1: no rule contexts' };
  const contexts = await Promise.all(
    rules.map(async (finding, index) => {
      const ctx = await buildAnalysisContext(finding);
      return `source_index=${index}
kind=${finding.kind}
title=${finding.title}
body=${finding.body}
evidence=${stableJson(finding.evidence[0])}
context=${analysisContextText(finding, ctx)}`;
    }),
  );
  const prompt = `Rewrite these rule-selected Lathe candidate contexts into 1 to 5 concise phenomenon-level findings.

Constraints:
- Preserve the observable phenomenon; do not prescribe harness-file edits.
- Return one item per useful source_index, up to 5.
- Use the source index; evidence and kind will be preserved by the caller.
- Every item must include analysis with cause_hypothesis, agent_intent, and impact.
- cause_hypothesis must identify the concrete failure mechanism shown by context. Do not merely say the agent returned to the same failed evidence or that the finding is a failure_loop.
- Prefer command semantics and error text over category labels: rg exit 1 = no match, git diff --check exit 2 = whitespace findings, gh Projects classic sunset = CLI GraphQL failure, No such file = wrong path/cwd, EADDRINUSE = occupied port, fixture-only checks = real-data gap.
- Prefer distinct known-incident cue mechanisms over aggregate "many errors" summaries: cost prefix overcount, data-dependent flake, EADDRINUSE, fixture/self-sufficient real-data gap, and binary-framing/existence-proof incidents should each survive when present.
- If context only supports a structural rule-based observation, set cause_hypothesis to null.

Rule candidates:
${contexts.join('\n\n')}`;
  const response = await callLlmJson(prompt, hybridFindingSchema(), 'hybrid-v1', options.llmProviderMode);
  if (response.skipped) return { drafts: [], skipped: response.skipped, log: response.log };
  if (process.env.LATHE_ANALYST_DEBUG_LLM === '1') {
    console.error(`[analyst:debug] hybrid-v1 raw=${JSON.stringify(response.value)}`);
  }
  const record = response.value && typeof response.value === 'object' ? (response.value as Record<string, unknown>) : {};
  const items = Array.isArray(record.findings) ? record.findings : [];
  const out: AnalystFindingDraft[] = [];
  const usedSourceIndexes = new Set<number>();
  for (const item of items) {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const sourceIndex = typeof row.source_index === 'number' ? Math.trunc(row.source_index) : -1;
    const source = rules[sourceIndex];
    if (!source) continue;
    usedSourceIndexes.add(sourceIndex);
    out.push({
      ...source,
      title: cleanText(row.title, source.title),
      body: cleanText(row.body, source.body),
      confidence: typeof row.confidence === 'number' ? Math.max(0, Math.min(1, row.confidence)) : source.confidence,
      analysis: analysisFromRecord(row),
      detector: 'hybrid_llm_rewrite',
    });
  }
  for (const [sourceIndex, source] of rules.entries()) {
    if (usedSourceIndexes.has(sourceIndex)) continue;
    if (hybridSourcePriority(source) > 4) continue;
    out.push({
      ...source,
      detector: 'hybrid_rule_context',
    });
  }
  return { drafts: out, log: `${response.log} raw=${items.length} mapped=${out.length}` };
}

function locatorNumber(locator: Record<string, unknown> | undefined, key: string): number | null {
  const value = locator?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function firstLine(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean) ?? null;
}

function quoteContext(value: string | null | undefined, max = 140): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? `"${shorten(text, max)}"` : null;
}

interface AnalysisContext {
  session: SessionRow | null;
  target: EventRow | null;
  trigger: EventRow | null;
  before: EventRow | null;
  after: EventRow | null;
  path: string | null;
  evidenceText: string | null;
}

async function resolveHunkContext(subjectId: string): Promise<{
  session_id: string | null;
  path: string | null;
  event_id: string | null;
  seq: number | null;
} | null> {
  const row = await queryOne<{
    session_id: string | null;
    path: string | null;
    event_id: string | null;
    seq: number | null;
  }>(
    `SELECT cf.session_id,
            cf.path,
            a.event_id,
            e.seq
       FROM diff_hunks h
       JOIN changed_files cf ON cf.id = h.file_id
       LEFT JOIN attributions a ON a.hunk_id = h.id AND a.event_id IS NOT NULL
       LEFT JOIN transcript_events e ON e.id = a.event_id
      WHERE h.id = $1
      ORDER BY a.confidence ASC NULLS LAST, a.id ASC NULLS LAST
      LIMIT 1`,
    [subjectId],
  );
  return row ?? null;
}

async function buildAnalysisContext(finding: AnalystFindingDraft): Promise<AnalysisContext> {
  const primary = finding.evidence[0];
  let sessionId = primary?.sessionId ?? (primary?.subjectKind === 'session' ? primary.subjectId : undefined);
  let targetSeq = locatorNumber(primary?.locator, 'seq');
  let targetEventId = primary?.subjectKind === 'event' ? primary.subjectId : undefined;
  let pathHint: string | null = typeof primary?.locator?.path === 'string' ? primary.locator.path : null;

  if (primary?.subjectKind === 'hunk' && primary.subjectId) {
    const hunk = await resolveHunkContext(primary.subjectId);
    sessionId = sessionId ?? hunk?.session_id ?? undefined;
    targetEventId = targetEventId ?? hunk?.event_id ?? undefined;
    targetSeq = targetSeq ?? hunk?.seq ?? null;
    pathHint = pathHint ?? hunk?.path ?? null;
  }

  let target: EventRow | null = null;
  if (targetEventId) {
    target = await queryOne<EventRow>(
      `SELECT id,session_id,seq,type,title,body,command,exit_code
         FROM transcript_events
        WHERE id = $1`,
      [targetEventId],
    ) ?? null;
    sessionId = sessionId ?? target?.session_id ?? undefined;
    targetSeq = targetSeq ?? target?.seq ?? null;
  }
  if (!target && sessionId && targetSeq != null) {
    target = await queryOne<EventRow>(
      `SELECT id,session_id,seq,type,title,body,command,exit_code
         FROM transcript_events
        WHERE session_id = $1
          AND seq = $2
        ORDER BY id ASC
        LIMIT 1`,
      [sessionId, targetSeq],
    ) ?? null;
  }

  const session = sessionId ? (await listTargetSessions({ candidate: finding.analyst as AnalystCandidate, sessionId })).find((row) => row.id === sessionId) ?? null : null;
  const events = sessionId
    ? targetSeq == null
      ? await queryRows<EventRow>(
          `SELECT id,session_id,seq,type,title,body,command,exit_code
             FROM transcript_events
            WHERE session_id = $1
              AND (
                type = 'user_message'
                OR (exit_code IS NOT NULL AND exit_code <> 0)
                OR (COALESCE(title,'') || ' ' || COALESCE(body,'') || ' ' || COALESCE(command,'')) ~*
                   '(データ依存|EADDRINUSE|address already in use|自己充足|実データリンク|0 行|二分法|存在証明|過大計上|prefix|overcount|projectCards|Projects classic|No such file|BERT|user dictionary|AivisSpeech)'
              )
            ORDER BY seq ASC, id ASC
            LIMIT 240`,
          [sessionId],
        )
      : await queryRows<EventRow>(
          `SELECT id,session_id,seq,type,title,body,command,exit_code
             FROM transcript_events
            WHERE session_id = $1
              AND (
                seq BETWEEN GREATEST(1, $2::int - 4) AND ($2::int + 4)
                OR (type = 'user_message' AND seq <= $2::int)
              )
            ORDER BY seq ASC, id ASC
            LIMIT 120`,
          [sessionId, targetSeq],
        )
    : [];

  const costCueTarget = finding.kind === 'excess_cost'
    ? events.find((event) => /(過大計上|overcount|prefix|3\s*倍|3x|opus)/i.test(eventText(event))) ?? null
    : null;
  const portCueTarget = finding.detector === 'port_collision_cue'
    ? events.find((event) => /EADDRINUSE|address already in use/i.test(eventText(event))) ?? null
    : null;
  const fixtureCueTarget = finding.detector === 'self_sufficient_fixture_cue'
    ? events.find((event) => SELF_SUFFICIENT_FIXTURE.test(eventText(event))) ?? null
    : null;
  const cueTarget = costCueTarget ?? portCueTarget ?? fixtureCueTarget ?? events.find((event) => {
    const text = eventText(event);
    return (
      DATA_DEPENDENT_FLAKE.test(text) ||
      SELF_SUFFICIENT_FIXTURE.test(text) ||
      BISECTION_ACCIDENT.test(text) ||
      /EADDRINUSE|address already in use|過大計上|prefix|overcount|projectCards|Projects classic|No such file|BERT|user dictionary|AivisSpeech/i.test(text)
    );
  }) ?? null;
  const fallbackTarget =
    target ??
    cueTarget ??
    events.find((event) => event.exit_code != null && event.exit_code !== 0) ??
    events.find((event) => event.type !== 'user_message') ??
    events[0] ??
    null;
  const effectiveSeq = targetSeq ?? fallbackTarget?.seq ?? null;
  const targetIndex = fallbackTarget ? events.findIndex((event) => event.id === fallbackTarget.id) : -1;
  const before = targetIndex > 0 ? events[targetIndex - 1] : null;
  const after = targetIndex >= 0 && targetIndex + 1 < events.length ? events[targetIndex + 1] : null;
  const trigger =
    [...events]
      .reverse()
      .find((event) => event.type === 'user_message' && (effectiveSeq == null || event.seq <= effectiveSeq)) ?? null;

  return {
    session,
    target: fallbackTarget,
    trigger,
    before,
    after,
    path: pathHint,
    evidenceText: firstLine(fallbackTarget?.body) ?? fallbackTarget?.title ?? primary?.note ?? finding.title,
  };
}

function evidenceAnchor(ctx: AnalysisContext): string | null {
  if (ctx.target?.command) return `command ${quoteContext(ctx.target.command)}`;
  if (ctx.path) return `path ${quoteContext(ctx.path)}`;
  if (ctx.evidenceText) return `evidence ${quoteContext(ctx.evidenceText)}`;
  if (ctx.session) return `session ${quoteContext(ctx.session.title)}`;
  return null;
}

function analysisContextText(finding: AnalystFindingDraft, ctx: AnalysisContext): string {
  return [
    ctx.session ? `session=${shorten(ctx.session.title, 120)} runner=${ctx.session.runner}` : null,
    ctx.trigger ? `user_asked seq=${ctx.trigger.seq}: ${shorten(firstLine(ctx.trigger.body) ?? ctx.trigger.title, 180)}` : null,
    ctx.before ? `before seq=${ctx.before.seq}: ${shorten([ctx.before.title, ctx.before.command, firstLine(ctx.before.body)].filter(Boolean).join(' | '), 180)}` : null,
    ctx.target ? `target seq=${ctx.target.seq} type=${ctx.target.type} exit=${ctx.target.exit_code ?? 'null'}: ${shorten([ctx.target.title, ctx.target.command, firstLine(ctx.target.body)].filter(Boolean).join(' | '), 260)}` : null,
    ctx.after ? `after seq=${ctx.after.seq}: ${shorten([ctx.after.title, ctx.after.command, firstLine(ctx.after.body)].filter(Boolean).join(' | '), 180)}` : null,
    ctx.path ? `path=${ctx.path}` : null,
    `finding=${shorten(`${finding.title} ${finding.body}`, 260)}`,
  ]
    .filter(Boolean)
    .join(' || ');
}

function analysisCorpus(finding: AnalystFindingDraft, ctx: AnalysisContext): string {
  return [
    finding.title,
    finding.body,
    ctx.session?.title,
    ctx.path,
    ctx.trigger?.title,
    ctx.trigger?.body,
    ctx.before?.title,
    ctx.before?.command,
    ctx.before?.body,
    ctx.target?.title,
    ctx.target?.command,
    ctx.target?.body,
    ctx.after?.title,
    ctx.after?.command,
    ctx.after?.body,
    ctx.evidenceText,
  ]
    .filter(Boolean)
    .join('\n');
}

function inferredMechanismAnalysis(
  finding: AnalystFindingDraft,
  ctx: AnalysisContext,
): Pick<NonNullable<SubmitFindingInput['analysis']>, 'causeHypothesis' | 'impact'> | null {
  const corpus = analysisCorpus(finding, ctx);
  const command = ctx.target?.command ?? '';
  const anchor = evidenceAnchor(ctx) ?? `finding ${quoteContext(finding.title)}`;
  const exit = ctx.target?.exit_code;

  if (finding.kind === 'failure_loop') {
    if ((/\brg\b|\bripgrep\b/i.test(command) || /\brg\b|\bripgrep\b/i.test(corpus)) && exit === 1) {
      return {
        causeHypothesis: `Mechanism: ${anchor} returned exit 1 from ripgrep, which normally means "no matches" rather than a crashed command; the loop came from treating a useful negative search result as a failure to retry.`,
        impact: `This matters because the correct conclusion is "the searched string is absent"; repeating the same rg command spends turns without increasing evidence.`,
      };
    }
    if (/git\s+diff\b[^\n]*--check/i.test(corpus) && (exit === 2 || /trailing whitespace|whitespace/i.test(corpus))) {
      return {
        causeHypothesis: `Mechanism: ${anchor} is a git diff --check diagnostic. Its non-zero exit reports whitespace findings, so retrying it as if the command malfunctioned cannot change the result without changing the checked paths or files.`,
        impact: `This separates an expected diagnostic signal from an execution failure, which prevents pre-flight checks from becoming repeated noise.`,
      };
    }
    if (/gh\s+issue\s+view/i.test(corpus) && /--comments/i.test(corpus) && /(projectcards|projects classic|sunset|classic)/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: ${anchor} hit the gh issue view --comments Projects classic GraphQL path; the transcript points at the retired projectCards/Projects classic field, so changing issue numbers repeats the same API failure.`,
        impact: `The useful move is to change the retrieval shape, not repeat issue IDs; otherwise issue audit work burns turns on a known API incompatibility.`,
      };
    }
    if (/no such file|enoent|cannot open|can't open/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: ${anchor} failed because the target path was absent from the current working directory; changing only the line range keeps querying the same nonexistent file.`,
        impact: `The next diagnostic should verify cwd/path, because paging through ranges cannot recover from a missing file.`,
      };
    }
    if (/eaddrinuse|address already in use/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: ${anchor} failed because the requested local port was already occupied, so the failure is a runtime process/cache collision rather than an application assertion failure.`,
        impact: `Treating the occupied port as product behavior would misclassify an environment setup problem and make reruns non-deterministic.`,
      };
    }
    if (/(自己充足|self[- ]?sufficient|fixture)/i.test(corpus) && /(実データリンク|0\s*行|0\s*rows?|real[- ]?data|absent)/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: fixture-shaped checks passed while the real-data link set was empty, so the validation loop proved the fixture path rather than the production-shaped behavior.`,
        impact: `This hides a real integration gap behind green local checks; future verification needs real rows or it will keep accepting self-contained evidence.`,
      };
    }
    if (/aivisspeech|bert|user dictionary|127\.0\.0\.1:10101/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: ${anchor} depends on the local AivisSpeech engine and its BERT/user-dictionary load state, so exit status is controlled by an external runtime service rather than only repo code.`,
        impact: `Reviewers need to isolate local service readiness before treating the failure as reproducible application behavior.`,
      };
    }
    if (/データ依存|data[- ]dependent|flake|flaky/i.test(corpus)) {
      return {
        causeHypothesis: `Mechanism: the failure depends on selected data or environment state, so the same test command can change result without a code change.`,
        impact: `The finding should be reviewed as nondeterministic input/environment behavior, not as a stable product regression.`,
      };
    }
  }

  if (finding.kind === 'excess_cost' && /(過大計上|overcount|prefix|3\s*倍|3x|opus)/i.test(corpus)) {
    return {
      causeHypothesis: `Mechanism: the cost spike is tied to Opus prefix/token accounting overcount in the transcript, not simply to a large amount of useful work.`,
      impact: `Cost triage should separate accounting inflation from genuine session effort before setting budgets or blaming the run shape.`,
    };
  }

  if (finding.kind === 'risky_action' && /(二分法|binary framing|existence[- ]proof|存在証明)/i.test(corpus)) {
    return {
      causeHypothesis: `Mechanism: the agent framed the design as a binary choice before using the existence proof from working ingest behavior, so the reasoning shortcut narrowed the search space prematurely.`,
      impact: `This can produce unnecessary rewrites because the review starts from a false dichotomy instead of observed working behavior.`,
    };
  }

  if (finding.kind === 'unattributed_diff' && ctx.path) {
    return {
      causeHypothesis: `Mechanism: path ${quoteContext(ctx.path)} has a changed hunk without a producing transcript event, so the audit trail is missing the step that created the diff.`,
      impact: `The file-level change cannot be checked against the agent turn that made it, weakening regression review for that path.`,
    };
  }

  return null;
}

function buildStructuralAnalysis(finding: AnalystFindingDraft, ctx: AnalysisContext): NonNullable<SubmitFindingInput['analysis']> | null {
  const anchor = evidenceAnchor(ctx);
  if (!anchor && !ctx.session) return null;

  const triggerText = quoteContext(firstLine(ctx.trigger?.body) ?? ctx.trigger?.title, 120);
  const eventSeq = ctx.target ? `seq ${ctx.target.seq}` : null;
  const location = [ctx.session ? `session ${quoteContext(ctx.session.title, 90)}` : null, eventSeq].filter(Boolean).join(', ');

  const agentIntent = triggerText && anchor
    ? `The user asked ${triggerText}; the agent was working through ${anchor}${location ? ` at ${location}` : ''}.`
    : anchor
      ? `The agent action is grounded in ${anchor}${location ? ` at ${location}` : ''}.`
      : null;

  let impact: string | null = null;
  if (finding.kind === 'failure_loop') {
    impact = anchor
      ? `Structural rule-based note: ${anchor} repeated as a non-zero signal. This is enough to flag a review target, but rules-v1 does not infer the deeper failure mechanism without LLM/context-specific analysis.`
      : null;
  } else if (finding.kind === 'unattributed_diff') {
    impact = ctx.path
      ? `Structural rule-based note: path ${quoteContext(ctx.path)} lacks direct event attribution, so the diff needs human or LLM review to explain why that traceability gap occurred.`
      : null;
  } else if (finding.kind === 'excess_cost') {
    impact = ctx.session
      ? `Structural rule-based note: ${quoteContext(ctx.session.title)} exceeds the ${ctx.session.runner} cost baseline; rules-v1 flags the outlier but does not infer the accounting or workflow cause.`
      : null;
  } else if (finding.kind === 'risky_action') {
    impact = anchor
      ? `Structural rule-based note: ${anchor} matches a risky-action cue; rules-v1 flags the coordinate without claiming a deeper causal story.`
      : null;
  }

  if (!agentIntent && !impact) return null;
  return { causeHypothesis: null, agentIntent, impact };
}

function causeLooksGeneric(value: string | null | undefined): boolean {
  if (!value) return false;
  return [
    /same failing evidence/i,
    /surrounding turn kept returning/i,
    /likely cause is visible/i,
    /encountered an issue/i,
    /needs further investigation/i,
    /may indicate an issue/i,
    /failure_loop/i,
  ].some((pattern) => pattern.test(value));
}

function causeHasMechanism(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(exit\s*[12]|no matches|no[- ]match|git diff --check|whitespace|projectcards|projects classic|sunset|no such file|cwd|eaddrinuse|port|fixture|real[- ]data|実データ|データ依存|data[- ]dependent|aivisspeech|bert|user dictionary|overcount|過大計上|prefix|二分法|binary framing|existence[- ]proof|存在証明|unattributed|audit trail|circuit[- ]breaker|max[- ]error|error[- ]rate|abort guard|session_id|aggregator|read-before-write|invariant|shell[- ]escaping|str_replace|anchor mismatch|retry loop|scope)/i.test(value);
}

function normalizeAnalysisInput(input: SubmitFindingInput['analysis'] | null | undefined): NonNullable<SubmitFindingInput['analysis']> | null {
  if (!input) return null;
  const causeHypothesis = analysisTextField(input.causeHypothesis);
  const agentIntent = analysisTextField(input.agentIntent);
  const impact = analysisTextField(input.impact);
  return causeHypothesis || agentIntent || impact ? { causeHypothesis, agentIntent, impact } : null;
}

function mergeAnalysis(
  primary: NonNullable<SubmitFindingInput['analysis']> | null,
  fallback: NonNullable<SubmitFindingInput['analysis']> | null,
): NonNullable<SubmitFindingInput['analysis']> | null {
  if (!primary) return fallback;
  const fallbackCause = fallback?.causeHypothesis ?? null;
  const primaryCause = primary.causeHypothesis ?? null;
  const causeHypothesis =
    primaryCause && !causeLooksGeneric(primaryCause) && (causeHasMechanism(primaryCause) || !fallbackCause)
      ? primaryCause
      : fallbackCause;
  const agentIntent = primary.agentIntent ?? fallback?.agentIntent ?? null;
  const impact = primary.impact ?? fallback?.impact ?? null;
  return causeHypothesis || agentIntent || impact ? { causeHypothesis, agentIntent, impact } : null;
}

function buildGroundedAnalysis(finding: AnalystFindingDraft, ctx: AnalysisContext): NonNullable<SubmitFindingInput['analysis']> | null {
  const structural = buildStructuralAnalysis(finding, ctx);
  if (finding.analyst === 'rules-v1') return structural;
  const mechanism = inferredMechanismAnalysis(finding, ctx);
  if (!mechanism) return structural;
  return {
    causeHypothesis: mechanism.causeHypothesis,
    agentIntent: structural?.agentIntent ?? null,
    impact: mechanism.impact ?? structural?.impact ?? null,
  };
}

function analysisJsonPayload(analysis: NonNullable<SubmitFindingInput['analysis']>): Record<string, string | null> {
  return {
    cause_hypothesis: analysis.causeHypothesis ?? null,
    agent_intent: analysis.agentIntent ?? null,
    impact: analysis.impact ?? null,
  };
}

async function attachAnalysis(drafts: AnalystFindingDraft[]): Promise<AnalystFindingDraft[]> {
  const enriched: AnalystFindingDraft[] = [];
  for (const draft of drafts) {
    const ctx = await buildAnalysisContext(draft);
    const grounded = buildGroundedAnalysis(draft, ctx);
    enriched.push({
      ...draft,
      analysis: draft.analyst === 'rules-v1'
        ? grounded
        : mergeAnalysis(normalizeAnalysisInput(draft.analysis), grounded),
    });
  }
  return enriched;
}

interface ExistingFindingRow {
  id: number;
  analyst: string;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  project_id: string;
  harness_version_id: string | null;
  analysis: string | Record<string, unknown> | null;
}

interface ExistingEvidenceRow {
  finding_id: number;
  subject_kind: SubmitFindingInput['evidence'][number]['subjectKind'];
  session_id: string | null;
  locator: string | Record<string, unknown> | null;
  subject_id: string | null;
  note: string | null;
}

function parseEvidenceLocator(value: ExistingEvidenceRow['locator']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function backfillFindingAnalysis(findingIds: number[]): Promise<{ considered: number; updated: number; skipped: number }> {
  if (!findingIds.length) return { considered: 0, updated: 0, skipped: 0 };
  const rows = await queryRows<ExistingFindingRow>(
    `SELECT id, analyst, kind, title, body, confidence, project_id, harness_version_id, analysis
       FROM findings
      WHERE id = ANY($1::int[])
      ORDER BY id ASC`,
    [findingIds],
  );
  const evidenceRows = rows.length
    ? await queryRows<ExistingEvidenceRow>(
        `SELECT finding_id, subject_kind, session_id, locator, subject_id, note
           FROM finding_evidence
          WHERE finding_id = ANY($1::int[])
          ORDER BY finding_id ASC, id ASC`,
        [rows.map((row) => row.id)],
      )
    : [];
  const evidenceByFinding = new Map<number, ExistingEvidenceRow[]>();
  for (const evidence of evidenceRows) {
    const list = evidenceByFinding.get(evidence.finding_id) ?? [];
    list.push(evidence);
    evidenceByFinding.set(evidence.finding_id, list);
  }

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (parseStoredAnalysis(row.analysis)) {
      skipped++;
      continue;
    }
    const evidence = (evidenceByFinding.get(row.id) ?? []).map((item) => ({
      subjectKind: item.subject_kind,
      subjectId: item.subject_id ?? undefined,
      sessionId: item.session_id ?? undefined,
      locator: parseEvidenceLocator(item.locator),
      note: item.note ?? undefined,
    }));
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
      evidence,
      detector: 'analysis_backfill',
    };
    const ctx = await buildAnalysisContext(draft);
    const analysis = buildGroundedAnalysis(draft, ctx);
    if (!analysis) {
      skipped++;
      continue;
    }
    await getPool().query('UPDATE findings SET analysis = $2::jsonb WHERE id = $1', [row.id, analysisJsonPayload(analysis)]);
    updated++;
  }
  return { considered: rows.length, updated, skipped };
}

async function submitDrafts(drafts: AnalystFindingDraft[], options: RunAnalystOptions): Promise<RunAnalystResult> {
  const logs: string[] = [];
  const limit = clampLimit(options.limit);
  const unique = new Map<string, AnalystFindingDraft>();
  for (const draft of drafts) {
    const key = findingKey(draft);
    const prior = unique.get(key);
    if (!prior || draft.confidence > prior.confidence) unique.set(key, draft);
  }
  const selected = await attachAnalysis([...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit));
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
    const result = await runLlmCandidate(options);
    if (result.skipped) {
      return {
        candidate: options.candidate,
        generated: 0,
        submitted: 0,
        created: 0,
        skipped: true,
        skipReason: result.skipped,
        findings: [],
        logs: [result.log],
      };
    }
    const submitted = await submitDrafts(result.drafts, options);
    submitted.logs.unshift(result.log);
    return submitted;
  }
  const result = await runHybridCandidate(options);
  if (result.skipped) {
    return {
      candidate: options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: result.skipped,
      findings: [],
      logs: [result.log],
    };
  }
  const submitted = await submitDrafts(result.drafts, options);
  submitted.logs.unshift(result.log);
  return submitted;
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
  const text = (key: string) => {
    const item = parsed[key];
    return typeof item === 'string' && item.trim() ? item.trim() : null;
  };
  const analysis = {
    causeHypothesis: text('cause_hypothesis'),
    agentIntent: text('agent_intent'),
    impact: text('impact'),
  };
  return analysis.causeHypothesis || analysis.agentIntent || analysis.impact ? analysis : null;
}

const GENERIC_ANALYSIS_PATTERNS = [
  /\b(needs further investigation|requires review|may indicate an issue|potential problem)\b/i,
  /the (agent|session) (encountered|had) (an )?(issue|problem)/i,
  /the likely cause is visible in\b/i,
  /same failing evidence/i,
  /surrounding turn kept returning/i,
  /undifferentiated failure/i,
];
const TOKEN_STOPLIST = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'session',
  'fixture',
  'finding',
  'assistant',
  'user',
  'message',
  'null',
]);

const KNOWN_INCIDENT_INSIGHTS: Record<string, Array<{ label: string; any: RegExp[] }>> = {
  'cost-opus-prefix-overcount': [
    { label: 'prefix/accounting mechanism', any: [/prefix/i, /前置/, /キャッシュ/, /cached/i] },
    { label: 'overcount magnitude', any: [/3\s*(x|倍)/i, /過大計上/, /overcount/i] },
    { label: 'cost/token impact', any: [/cost/i, /token/i, /計上/, /単価/] },
  ],
  'e2e-data-dependent-flake': [
    { label: 'data-dependent mechanism', any: [/データ依存/, /data[- ]dependent/i, /selected data/i] },
    { label: 'non-deterministic result', any: [/flake/i, /flaky/i, /再現性/, /same test command can change/i] },
  ],
  'next-dev-port-collision': [
    { label: 'port collision', any: [/EADDRINUSE/i, /address already in use/i, /port .*occupied/i, /occupied port/i] },
    { label: 'environment not product failure', any: [/runtime process/i, /environment/i, /cache/i, /setup/i, /not .*application/i] },
  ],
  'tasks-13-fixture-self-sufficiency': [
    { label: 'fixture-only path', any: [/自己充足/, /fixture/i, /self[- ]contained/i, /self[- ]sufficient/i] },
    { label: 'real-data absence', any: [/実データ.*0\s*行/, /real[- ]data/i, /0\s*rows?/i, /empty .*link/i] },
  ],
  'observation-ingest-bisection-accident': [
    { label: 'binary framing', any: [/二分法/, /binary framing/i, /false dichotomy/i] },
    { label: 'existence proof', any: [/存在証明/, /existence[- ]proof/i, /working implementation/i, /observed working/i] },
  ],
};

function groundingTokens(value: string): string[] {
  const raw = value.match(/[A-Za-z0-9_./:@-]{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) ?? [];
  return [...new Set(raw.map((token) => token.toLowerCase()).filter((token) => !TOKEN_STOPLIST.has(token)))].slice(0, 80);
}

async function assertAnalysisGrounded(seedSessionIds: string[]): Promise<void> {
  const rows = await queryRows<{
    id: number;
    analyst: AnalystCandidate;
    analysis: string | Record<string, unknown> | null;
    evidence_text: string | null;
  }>(
    `SELECT f.id,
            f.analyst,
            f.analysis,
            string_agg(DISTINCT concat_ws(' ',
              s.title,
              e.title,
              e.command,
              e.body,
              cf.path,
              fe.note
            ), ' ') AS evidence_text
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
       LEFT JOIN sessions s
         ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
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

  let nonNullFields = 0;
  const bad: string[] = [];
  for (const row of rows) {
    const analysis = parseStoredAnalysis(row.analysis);
    if (!analysis) {
      bad.push(`#${row.id}: missing analysis`);
      continue;
    }
    const fields = [analysis.causeHypothesis, analysis.agentIntent, analysis.impact].filter(
      (item): item is string => Boolean(item),
    );
    nonNullFields += fields.length;
    if (fields.length < 2) bad.push(`#${row.id}: too few analysis fields (${fields.length}/3)`);

    const text = fields.join(' ').toLowerCase();
    if (GENERIC_ANALYSIS_PATTERNS.some((pattern) => pattern.test(text))) {
      bad.push(`#${row.id}: generic analysis wording`);
    }
    if (row.analyst === 'rules-v1') {
      if (analysis.causeHypothesis && !/^structural rule-based note/i.test(analysis.causeHypothesis)) {
        bad.push(`#${row.id}: rules-v1 cause pretends to be deep analysis`);
      }
    } else {
      if (analysis.causeHypothesis && causeLooksGeneric(analysis.causeHypothesis)) {
        bad.push(`#${row.id}: ${row.analyst} cause_hypothesis is generic (${shorten(analysis.causeHypothesis, 160)})`);
      }
    }
    const tokens = groundingTokens(row.evidence_text ?? '');
    if (!tokens.some((token) => text.includes(token))) {
      bad.push(`#${row.id}: analysis does not mention evidence-specific command/path/session text`);
    }
  }

  const rate = nonNullFields / Math.max(1, rows.length * 3);
  if (rate < 0.66) bad.push(`non-null analysis field rate too low: ${nonNullFields}/${rows.length * 3}`);
  if (bad.length) throw new Error(`analysis grounding smoke failed: ${bad.join('; ')}`);
}

function analysisInsightText(row: {
  title: string;
  body: string;
  analysis: string | Record<string, unknown> | null;
  evidence_text: string | null;
}): string {
  const analysis = parseStoredAnalysis(row.analysis);
  return [
    row.title,
    row.body,
    analysis?.causeHypothesis,
    analysis?.agentIntent,
    analysis?.impact,
    row.evidence_text,
  ]
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
         LEFT JOIN sessions s
           ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
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
      bad.push(`${incident.id}: hybrid-v1 analysis missed expected insight; candidates=${hybridRows.map((row) => `#${row.id} ${shorten(analysisInsightText(row), 220)}`).join(' || ')}`);
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
