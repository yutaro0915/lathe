// Session read concern: list sessions and get session events (spine).
// Depends on shared.ts and ./postgres only.

import { queryOne, queryRows } from './postgres';
import { cleanNumber, cleanString, normalizeLimit } from './shared';

export interface ListSessionsFilter {
  projectId?: string;
  runner?: string;
  model?: string;
  sessionClass?: string;
  includeClasses?: string[];
  limit?: number;
  offset?: number;
  orderBy?: string;
}

export interface McpSessionSummary {
  id: string;
  projectId: string;
  title: string;
  runner: string;
  model: string | null;
  costUsd: number | null;
  harnessVersionId: string | null;
  status: string;
  turnCount: number;
  toolCount: number;
  editCount: number;
  bashCount: number;
  subagentCount: number;
  errorCount: number;
  tokenUsage: number;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  parentSessionId: string | null;
  sessionClass: string;
}

export interface GetSessionEventsInput {
  sessionId: string;
  seqFrom?: number;
  seqTo?: number;
  subagent?: string;
  types?: string[];
  errorsOnly?: boolean;
  limit?: number;
  offset?: number;
}

interface SessionSummaryRow {
  id: string;
  project_id: string;
  title: string;
  runner: string;
  model: string | null;
  cost_usd: number | null;
  harness_version_id: string | null;
  status: string;
  turn_count: number;
  tool_count: number;
  edit_count: number;
  bash_count: number;
  subagent_count: number;
  error_count: number;
  token_usage: number;
  duration_ms: number | null;
  started_at: string;
  ended_at: string | null;
  parent_session_id: string | null;
  session_class: string;
}

interface SpineEventRow {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  title: string;
  command: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  token_usage: number | null;
  subagent: string | null;
  __total: number;
}

export interface SessionRow extends SessionSummaryRow {
  project: string;
  token_in: number;
  token_out: number;
  git_branch: string | null;
  commit_count: number;
  summary: string | null;
  spawned_by_seq: number | null;
  seq: number;
}

const DEFAULT_SESSION_CLASS = 'development';

function resolveOrderBy(orderBy: string | undefined): string {
  switch (orderBy) {
    case 'cost_usd':
      return 'cost_usd DESC NULLS LAST, id ASC';
    case 'error_count':
      return 'error_count DESC, id ASC';
    case 'turn_count':
      return 'turn_count DESC, id ASC';
    case 'duration_ms':
      return 'duration_ms DESC NULLS LAST, id ASC';
    default:
      return 'started_at DESC NULLS LAST, id ASC';
  }
}

function normalizeClassList(values: string[] | undefined): string[] {
  const classes: string[] = [];
  for (const value of values ?? []) {
    const sessionClass = cleanString(value);
    if (sessionClass && !classes.includes(sessionClass)) classes.push(sessionClass);
  }
  return classes;
}

function toSessionSummary(row: SessionSummaryRow): McpSessionSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    runner: row.runner,
    model: row.model,
    costUsd: row.cost_usd,
    harnessVersionId: row.harness_version_id,
    status: row.status,
    turnCount: row.turn_count,
    toolCount: row.tool_count,
    editCount: row.edit_count,
    bashCount: row.bash_count,
    subagentCount: row.subagent_count,
    errorCount: row.error_count,
    tokenUsage: row.token_usage,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    parentSessionId: row.parent_session_id,
    sessionClass: row.session_class,
  };
}

function toSpineEvent(row: SpineEventRow) {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    title: row.title,
    command: row.command,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    tokenUsage: row.token_usage,
    subagent: row.subagent,
  };
}

export async function getSession(id: string) {
  const row = await queryOne<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
  if (!row) return undefined;
  return {
    id: row.id,
    project: row.project,
    projectId: row.project_id,
    title: row.title,
    runner: row.runner,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    turnCount: row.turn_count,
    toolCount: row.tool_count,
    editCount: row.edit_count,
    bashCount: row.bash_count,
    subagentCount: row.subagent_count,
    errorCount: row.error_count,
    tokenUsage: row.token_usage,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    gitBranch: row.git_branch,
    commitCount: row.commit_count,
    costUsd: row.cost_usd,
    costAnomaly: false,
    costAnomalyThresholdUsd: 0,
    costAnomalyGroupSize: 0,
    costAnomalyGroupMedianUsd: null,
    harnessVersionId: row.harness_version_id,
    summary: row.summary,
    parentSessionId: row.parent_session_id,
    spawnedBySeq: row.spawned_by_seq,
    stepCount: 0,
    seq: row.seq,
  };
}

export async function listMcpSessions(filter: ListSessionsFilter = {}): Promise<{ total: number; sessions: McpSessionSummary[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const projectId = cleanString(filter.projectId);
  const runner = cleanString(filter.runner);
  const model = cleanString(filter.model);
  const sessionClass = cleanString(filter.sessionClass);
  const includeClasses = normalizeClassList(filter.includeClasses);
  if (projectId) where.push(`project_id = ${addParam(projectId)}`);
  if (runner) where.push(`runner = ${addParam(runner)}`);
  if (model) where.push(`model = ${addParam(model)}`);
  if (includeClasses.length > 0) {
    where.push(`session_class = ANY(${addParam(includeClasses)}::text[])`);
  } else {
    where.push(`session_class = ${addParam(sessionClass ?? DEFAULT_SESSION_CLASS)}`);
  }

  const limit = normalizeLimit(filter.limit);
  const offset = cleanNumber(filter.offset, 0);
  const orderClause = resolveOrderBy(filter.orderBy);
  const rows = await queryRows<SessionSummaryRow & { __total: number }>(
    `SELECT id,project_id,title,runner,model,cost_usd,harness_version_id,
            status,turn_count,tool_count,edit_count,bash_count,subagent_count,
            error_count,token_usage,duration_ms,started_at,ended_at,parent_session_id,session_class,
            COUNT(*) OVER() AS __total
       FROM sessions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderClause}
      LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
    params,
  );
  const total = rows.length > 0 ? Number(rows[0].__total) : 0;
  return { total, sessions: rows.map(toSessionSummary) };
}

export async function getSessionEvents(input: GetSessionEventsInput): Promise<{
  total: number;
  seqRange: { min: number; max: number } | null;
  events: ReturnType<typeof toSpineEvent>[];
}> {
  const sessionExists = await queryOne<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [input.sessionId]);
  if (!sessionExists) throw new Error(`session not found: ${input.sessionId}`);

  const where: string[] = ['session_id = $1'];
  const params: unknown[] = [input.sessionId];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (input.seqFrom !== undefined) where.push(`seq >= ${addParam(input.seqFrom)}`);
  if (input.seqTo !== undefined) where.push(`seq <= ${addParam(input.seqTo)}`);
  if (input.subagent !== undefined) where.push(`subagent = ${addParam(input.subagent)}`);
  if (input.types && input.types.length > 0) where.push(`type = ANY(${addParam(input.types)}::text[])`);
  if (input.errorsOnly) where.push('exit_code IS NOT NULL AND exit_code <> 0');

  const limit = Math.min(500, Math.max(1, cleanNumber(input.limit, 100)));
  const offset = cleanNumber(input.offset, 0);

  const [rows, rangeRow] = await Promise.all([
    queryRows<SpineEventRow>(
      `SELECT seq, ts, type, actor, LEFT(title, 200) AS title, command, exit_code, duration_ms, token_usage, subagent,
              COUNT(*) OVER() AS __total
         FROM transcript_events
        WHERE ${where.join(' AND ')}
        ORDER BY seq ASC, id ASC
        LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
      params,
    ),
    queryOne<{ min: number; max: number } | null>(
      'SELECT MIN(seq) AS min, MAX(seq) AS max FROM transcript_events WHERE session_id = $1',
      [input.sessionId],
    ),
  ]);

  const total = rows.length > 0 ? Number(rows[0].__total) : 0;
  const seqRange = rangeRow && rangeRow.min !== null ? { min: Number(rangeRow.min), max: Number(rangeRow.max) } : null;

  return { total, seqRange, events: rows.map(toSpineEvent) };
}
