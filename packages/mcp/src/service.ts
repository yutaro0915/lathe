import * as crypto from 'node:crypto';
import {
  EVIDENCE_SUBJECT_KINDS,
  FINDING_BODY_MAX_LENGTH,
  FINDING_EVIDENCE_MAX_ITEMS,
  FINDING_KINDS,
  FINDING_LOCATOR_MAX_LENGTH,
  FINDING_NOTE_MAX_LENGTH,
  FINDING_TITLE_MAX_LENGTH,
  VERDICT_FILTERS,
  assertEvidenceSubjectKind,
  assertFindingKind,
  isVerdictFilter,
  normalizeAnalysisForStorage,
  parseLocator,
  parseStoredAnalysis,
  stableJson,
  type EvidenceSubjectKind,
  type FindingAnalysisInput,
  type FindingEvidenceInput,
  type FindingKind,
  type SubmitFindingInput,
  type VerdictFilter,
} from '@lathe/domain';
import { getPool, queryOne, queryRows } from './postgres';

type JsonRecord = Record<string, unknown>;

export {
  EVIDENCE_SUBJECT_KINDS,
  FINDING_BODY_MAX_LENGTH,
  FINDING_EVIDENCE_MAX_ITEMS,
  FINDING_KINDS,
  FINDING_LOCATOR_MAX_LENGTH,
  FINDING_NOTE_MAX_LENGTH,
  FINDING_TITLE_MAX_LENGTH,
  VERDICT_FILTERS,
  parseStoredAnalysis,
  stableJson,
};
export type {
  EvidenceSubjectKind,
  FindingAnalysisInput,
  FindingEvidenceInput,
  FindingKind,
  SubmitFindingInput,
  VerdictFilter,
};

export interface ListSessionsFilter {
  projectId?: string;
  runner?: string;
  model?: string;
  limit?: number;
  offset?: number;
}

export interface McpSessionSummary {
  id: string;
  projectId: string;
  title: string;
  runner: string;
  model: string | null;
  costUsd: number | null;
  harnessVersionId: string | null;
}

export interface QueryFindingsFilter {
  kind?: FindingKind;
  verdict?: VerdictFilter;
  sessionId?: string;
  projectId?: string;
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
}

interface SessionRow extends SessionSummaryRow {
  project: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  tool_count: number;
  edit_count: number;
  bash_count: number;
  subagent_count: number;
  error_count: number;
  token_usage: number;
  token_in: number;
  token_out: number;
  git_branch: string | null;
  commit_count: number;
  summary: string | null;
  parent_session_id: string | null;
  spawned_by_seq: number | null;
  seq: number;
}

interface FindingRow {
  id: number;
  created_at: string;
  analyst: string;
  kind: string;
  title: string;
  body: string;
  confidence: number;
  harness_version_id: string | null;
  project_id: string;
  analysis: string | Record<string, unknown> | null;
  backlog_status: string | null;
  backlog_actor: string | null;
  verdict: string | null;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

interface EvidenceRow {
  id: number;
  finding_id: number;
  subject_kind: string;
  session_id: string | null;
  locator: string | Record<string, unknown> | null;
  subject_id: string | null;
  note: string | null;
}

interface ProjectAndHarnessRow {
  project_id: string;
  harness_version_id: string | null;
}

interface PullRequestSummaryRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  head_ref_name: string | null;
  merged_at: string | null;
  updated_at: string;
  link_method: string;
}

interface TranscriptEventRow {
  id: string;
  session_id: string;
  seq: number;
  ts: string;
  type: string;
  actor: string;
  title: string;
  body: string | null;
  file_path: string | null;
  command: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  token_usage: number | null;
  subagent: string | null;
  meta: string | null;
  parent_id: string | null;
}

interface ChangedFileRow {
  id: string;
  session_id: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  language: string | null;
  seq: number;
}

interface DiffHunkRow {
  id: string;
  file_id: string;
  seq: number;
  header: string;
  content: string;
}

interface AttributionRow {
  id: string;
  hunk_id: string;
  event_id: string | null;
  confidence: string;
  method: string;
  note: string | null;
}

interface EventFileRow {
  id: number;
  event_id: string;
  path: string;
  role: string;
}

interface AnnotationRow {
  id: number;
  session_id: string;
  at_seq: number;
  kind: string;
  note: string | null;
}

interface LinkedEventRow extends TranscriptEventRow {
  __confidence: string;
  __method: string;
  __hunk_id: string;
  __file_id: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function normalizeLimit(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, cleanNumber(value, DEFAULT_LIMIT)));
}

function assertMaxLength(label: string, value: string | undefined, max: number): void {
  if (value !== undefined && value.length > max) {
    throw new Error(`${label} must be ${max} characters or fewer`);
  }
}

function idempotencyKey(analyst: string, kind: FindingKind, evidence: FindingEvidenceInput): string {
  const payload = {
    analyst,
    kind,
    subjectKind: evidence.subjectKind,
    subjectId: evidence.subjectId ?? '',
    sessionId: evidence.sessionId ?? '',
    locator: evidence.locator ?? {},
  };
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function assertLocatorLength(locator: Record<string, unknown>): void {
  const serialized = stableJson(locator);
  if (serialized.length > FINDING_LOCATOR_MAX_LENGTH) {
    throw new Error(`evidence.locator must be ${FINDING_LOCATOR_MAX_LENGTH} characters or fewer`);
  }
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
  };
}

function toEvent(row: TranscriptEventRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    title: row.title,
    body: row.body,
    filePath: row.file_path,
    command: row.command,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    tokenUsage: row.token_usage,
    subagent: row.subagent,
    meta: row.meta,
    parentId: row.parent_id,
  };
}

function toChangedFile(row: ChangedFileRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    path: row.path,
    status: row.status,
    additions: row.additions,
    deletions: row.deletions,
    language: row.language,
    seq: row.seq,
  };
}

function toEvidence(row: EvidenceRow) {
  return {
    id: row.id,
    findingId: row.finding_id,
    subjectKind: row.subject_kind as EvidenceSubjectKind,
    sessionId: row.session_id,
    locator: parseLocator(row.locator),
    subjectId: row.subject_id,
    note: row.note,
  };
}

function toFinding(row: FindingRow, evidence: EvidenceRow[]) {
  return {
    id: row.id,
    createdAt: row.created_at,
    analyst: row.analyst,
    kind: row.kind as FindingKind,
    title: row.title,
    body: row.body,
    confidence: row.confidence,
    harnessVersionId: row.harness_version_id,
    projectId: row.project_id,
    analysis: parseStoredAnalysis(row.analysis),
    backlogStatus: row.backlog_status,
    backlogActor: row.backlog_actor,
    latestVerdict: row.verdict
      ? {
          verdict: row.verdict,
          reason: row.reason,
          decidedAt: row.decided_at,
          decidedBy: row.decided_by,
        }
      : null,
    evidence: evidence.map(toEvidence),
  };
}

function validateEvidenceInput(evidence: FindingEvidenceInput): FindingEvidenceInput {
  assertEvidenceSubjectKind(evidence.subjectKind);
  const subjectId = cleanString(evidence.subjectId);
  const sessionId = cleanString(evidence.sessionId);
  const locator = evidence.locator ?? {};
  if (locator === null || typeof locator !== 'object' || Array.isArray(locator)) {
    throw new Error('evidence locator must be an object when provided');
  }
  if (evidence.subjectKind === 'event' || evidence.subjectKind === 'hunk' || evidence.subjectKind === 'pr') {
    if (!subjectId) throw new Error(`${evidence.subjectKind} evidence requires subject_id`);
  } else if (evidence.subjectKind === 'session') {
    if (!subjectId && !sessionId) throw new Error('session evidence requires subject_id or session_id');
  } else if (evidence.subjectKind === 'turn') {
    if (!subjectId && !sessionId) throw new Error('turn evidence requires subject_id or session_id');
  }
  assertLocatorLength(locator);
  const note = cleanString(evidence.note);
  assertMaxLength('evidence.note', note, FINDING_NOTE_MAX_LENGTH);
  return {
    subjectKind: evidence.subjectKind,
    subjectId,
    sessionId,
    locator,
    note,
  };
}

export async function listMcpSessions(filter: ListSessionsFilter = {}): Promise<McpSessionSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const projectId = cleanString(filter.projectId);
  const runner = cleanString(filter.runner);
  const model = cleanString(filter.model);
  if (projectId) where.push(`project_id = ${addParam(projectId)}`);
  if (runner) where.push(`runner = ${addParam(runner)}`);
  if (model) where.push(`model = ${addParam(model)}`);

  const limit = normalizeLimit(filter.limit);
  const offset = cleanNumber(filter.offset, 0);
  const rows = await queryRows<SessionSummaryRow>(
    `SELECT id,project_id,title,runner,model,cost_usd,harness_version_id
       FROM sessions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq ASC, started_at DESC, id ASC
      LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
    params,
  );
  return rows.map(toSessionSummary);
}

async function getSession(id: string) {
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

export async function getMcpSessionBundle(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const [events, typeCountsRows, annotations, changedFiles, pullRequests] = await Promise.all([
    queryRows<TranscriptEventRow>(
      'SELECT * FROM transcript_events WHERE session_id = $1 ORDER BY seq ASC, parent_id NULLS FIRST, id ASC',
      [sessionId],
    ),
    queryRows<{ type: string; n: number }>(
      `SELECT type, COUNT(*)::int AS n
         FROM transcript_events
        WHERE session_id = $1
          AND parent_id IS NULL
        GROUP BY type`,
      [sessionId],
    ),
    queryRows<AnnotationRow>('SELECT * FROM annotations WHERE session_id = $1 ORDER BY at_seq ASC', [sessionId]),
    queryRows<ChangedFileRow>('SELECT * FROM changed_files WHERE session_id = $1 ORDER BY seq ASC', [sessionId]),
    queryRows<PullRequestSummaryRow>(
      `SELECT pr.id, pr.project_id, pr.number, pr.title, pr.state, pr.url,
              pr.head_ref_name, pr.merged_at, pr.updated_at, spr.source AS link_method
         FROM session_pull_requests spr
         JOIN pull_requests pr ON pr.id = spr.pr_id
        WHERE spr.session_id = $1
        ORDER BY spr.pr_updated_at DESC, pr.number DESC`,
      [sessionId],
    ),
  ]);
  const typeCounts: Record<string, number> = {};
  for (const row of typeCountsRows) typeCounts[row.type] = row.n;

  const eventIds = events.map((event) => event.id);
  const fileIds = changedFiles.map((file) => file.id);
  const [eventFileRows, hunkRows, attrRows, linkedRows] = await Promise.all([
    eventIds.length
      ? queryRows<EventFileRow>('SELECT * FROM event_files WHERE event_id = ANY($1::text[]) ORDER BY event_id ASC, id ASC', [
          eventIds,
        ])
      : Promise.resolve([]),
    fileIds.length
      ? queryRows<DiffHunkRow>('SELECT * FROM diff_hunks WHERE file_id = ANY($1::text[]) ORDER BY file_id ASC, seq ASC', [
          fileIds,
        ])
      : Promise.resolve([]),
    fileIds.length
      ? queryRows<AttributionRow & { file_id: string }>(
          `SELECT a.*, h.file_id
             FROM attributions a
             JOIN diff_hunks h ON h.id = a.hunk_id
            WHERE h.file_id = ANY($1::text[])
            ORDER BY a.hunk_id ASC, a.id ASC`,
          [fileIds],
        )
      : Promise.resolve([]),
    fileIds.length
      ? queryRows<LinkedEventRow>(
          `SELECT e.*,
                  a.confidence AS __confidence,
                  a.method     AS __method,
                  a.hunk_id    AS __hunk_id,
                  h.file_id    AS __file_id
             FROM attributions a
             JOIN diff_hunks h ON h.id = a.hunk_id
             JOIN transcript_events e ON e.id = a.event_id
            WHERE h.file_id = ANY($1::text[])
              AND a.event_id IS NOT NULL
            ORDER BY h.file_id ASC, h.seq ASC, e.seq ASC`,
          [fileIds],
        )
      : Promise.resolve([]),
  ]);

  const eventFiles: Record<string, unknown[]> = {};
  for (const row of eventFileRows) {
    (eventFiles[row.event_id] ??= []).push({ id: row.id, eventId: row.event_id, path: row.path, role: row.role });
  }

  const hunks: Record<string, unknown[]> = {};
  for (const file of changedFiles) hunks[file.id] = [];
  for (const row of hunkRows) {
    (hunks[row.file_id] ??= []).push({
      id: row.id,
      fileId: row.file_id,
      seq: row.seq,
      header: row.header,
      content: row.content,
    });
  }

  const attributions: Record<string, unknown[]> = {};
  for (const list of Object.values(hunks)) {
    for (const hunk of list as Array<{ id: string }>) attributions[hunk.id] = [];
  }
  for (const row of attrRows) {
    (attributions[row.hunk_id] ??= []).push({
      id: row.id,
      hunkId: row.hunk_id,
      eventId: row.event_id,
      confidence: row.confidence,
      method: row.method,
      note: row.note,
    });
  }

  const linkedEvents: Record<string, unknown[]> = {};
  for (const file of changedFiles) linkedEvents[file.id] = [];
  for (const row of linkedRows) {
    (linkedEvents[row.__file_id] ??= []).push({
      event: toEvent(row),
      confidence: row.__confidence,
      method: row.__method,
      hunkId: row.__hunk_id,
    });
  }

  return {
    session,
    pullRequests: pullRequests.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      number: row.number,
      title: row.title,
      state: row.state,
      url: row.url,
      headRefName: row.head_ref_name,
      mergedAt: row.merged_at,
      updatedAt: row.updated_at,
      linkMethod: row.link_method,
    })),
    events: events.map(toEvent),
    typeCounts,
    annotations: annotations.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      atSeq: row.at_seq,
      kind: row.kind,
      note: row.note,
    })),
    eventFiles,
    changedFiles: changedFiles.map(toChangedFile),
    hunks,
    attributions,
    linkedEvents,
  };
}

export async function queryFindings(filter: QueryFindingsFilter = {}) {
  if (filter.kind) assertFindingKind(filter.kind);
  if (filter.verdict && !isVerdictFilter(filter.verdict)) {
    throw new Error(`invalid verdict filter: ${filter.verdict}`);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.kind) where.push(`f.kind = ${addParam(filter.kind)}`);
  if (filter.projectId) where.push(`f.project_id = ${addParam(filter.projectId)}`);
  if (filter.sessionId) {
    const ref = addParam(filter.sessionId);
    where.push(`EXISTS (
      SELECT 1 FROM finding_evidence fe
       WHERE fe.finding_id = f.id
         AND (fe.session_id = ${ref} OR fe.subject_id = ${ref})
    )`);
  }
  if (filter.verdict === 'accept' || filter.verdict === 'reject') {
    where.push(`lv.verdict = ${addParam(filter.verdict)}`);
  } else if (filter.verdict === 'unreviewed') {
    where.push('lv.finding_id IS NULL');
  }

  const limit = normalizeLimit(filter.limit);
  const offset = cleanNumber(filter.offset, 0);
  const rows = await queryRows<FindingRow>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id)
              finding_id,verdict,reason,decided_at,decided_by
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.*,
            lv.verdict,
            lv.reason,
            lv.decided_at,
            lv.decided_by
       FROM findings f
       LEFT JOIN latest_verdict lv ON lv.finding_id = f.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
    params,
  );

  const ids = rows.map((row) => row.id);
  const evidence = ids.length
    ? await queryRows<EvidenceRow>(
        `SELECT *
           FROM finding_evidence
          WHERE finding_id = ANY($1::int[])
          ORDER BY finding_id ASC, id ASC`,
        [ids],
      )
    : [];
  const byFinding = new Map<number, EvidenceRow[]>();
  for (const row of evidence) {
    const list = byFinding.get(row.finding_id) ?? [];
    list.push(row);
    byFinding.set(row.finding_id, list);
  }
  return rows.map((row) => toFinding(row, byFinding.get(row.id) ?? []));
}

async function inferProjectAndHarness(evidence: FindingEvidenceInput[]): Promise<ProjectAndHarnessRow | undefined> {
  for (const item of evidence) {
    if (item.sessionId) {
      const row = await queryOne<ProjectAndHarnessRow>(
        'SELECT project_id,harness_version_id FROM sessions WHERE id = $1',
        [item.sessionId],
      );
      if (row) return row;
    }
    if (item.subjectKind === 'session' && item.subjectId) {
      const row = await queryOne<ProjectAndHarnessRow>(
        'SELECT project_id,harness_version_id FROM sessions WHERE id = $1',
        [item.subjectId],
      );
      if (row) return row;
    }
    if (item.subjectKind === 'event' && item.subjectId) {
      const row = await queryOne<ProjectAndHarnessRow>(
        `SELECT s.project_id,s.harness_version_id
           FROM transcript_events e
           JOIN sessions s ON s.id = e.session_id
          WHERE e.id = $1`,
        [item.subjectId],
      );
      if (row) return row;
    }
    if (item.subjectKind === 'hunk' && item.subjectId) {
      const row = await queryOne<ProjectAndHarnessRow>(
        `SELECT s.project_id,s.harness_version_id
           FROM diff_hunks h
           JOIN changed_files cf ON cf.id = h.file_id
           JOIN sessions s ON s.id = cf.session_id
          WHERE h.id = $1`,
        [item.subjectId],
      );
      if (row) return row;
    }
    if (item.subjectKind === 'pr' && item.subjectId) {
      const row = await queryOne<ProjectAndHarnessRow>(
        'SELECT project_id,NULL::text AS harness_version_id FROM pull_requests WHERE id = $1',
        [item.subjectId],
      );
      if (row) return row;
    }
  }
  return undefined;
}

async function queryFindingById(id: number) {
  const row = await queryOne<FindingRow>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id)
              finding_id,verdict,reason,decided_at,decided_by
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.*,
            lv.verdict,
            lv.reason,
            lv.decided_at,
            lv.decided_by
       FROM findings f
       LEFT JOIN latest_verdict lv ON lv.finding_id = f.id
      WHERE f.id = $1`,
    [id],
  );
  if (!row) return undefined;
  const evidence = await queryRows<EvidenceRow>(
    'SELECT * FROM finding_evidence WHERE finding_id = $1 ORDER BY id ASC',
    [id],
  );
  return toFinding(row, evidence);
}

export async function submitFinding(input: SubmitFindingInput) {
  const analyst = cleanString(input.analyst);
  const title = cleanString(input.title);
  const body = cleanString(input.body);
  if (!analyst) throw new Error('finding.analyst is required');
  assertFindingKind(input.kind);
  if (!title) throw new Error('finding.title is required');
  if (!body) throw new Error('finding.body is required');
  assertMaxLength('finding.title', title, FINDING_TITLE_MAX_LENGTH);
  assertMaxLength('finding.body', body, FINDING_BODY_MAX_LENGTH);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('finding.confidence must be between 0 and 1');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new Error('finding.evidence must contain at least one item');
  }
  if (input.evidence.length > FINDING_EVIDENCE_MAX_ITEMS) {
    throw new Error(`finding.evidence must contain ${FINDING_EVIDENCE_MAX_ITEMS} items or fewer`);
  }

  const evidence = input.evidence.map(validateEvidenceInput);
  const primary = evidence[0];
  const key = idempotencyKey(analyst, input.kind, primary);
  const inferred = await inferProjectAndHarness(evidence);
  const projectId = cleanString(input.projectId) ?? inferred?.project_id;
  if (!projectId) throw new Error('finding.project_id is required when evidence cannot infer a project');
  const harnessVersionId = input.harnessVersionId === undefined ? inferred?.harness_version_id ?? null : input.harnessVersionId;
  const analysis = normalizeAnalysisForStorage(input.analysis);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE findings, finding_evidence IN SHARE ROW EXCLUSIVE MODE');
    const duplicate = await client.query<{ id: number; title: string; body: string }>(
      `SELECT f.id
              ,f.title
              ,f.body
         FROM findings f
         JOIN LATERAL (
           SELECT fe.*
             FROM finding_evidence fe
            WHERE fe.finding_id = f.id
            ORDER BY fe.id ASC
            LIMIT 1
         ) primary_fe ON true
        WHERE f.analyst = $1
          AND f.kind = $2
          AND primary_fe.subject_kind = $3
          AND COALESCE(primary_fe.session_id, '') = $4
          AND COALESCE(primary_fe.subject_id, '') = $5
          AND primary_fe.locator = $6::jsonb
        ORDER BY f.id ASC
        LIMIT 1`,
      [analyst, input.kind, primary.subjectKind, primary.sessionId ?? '', primary.subjectId ?? '', primary.locator ?? {}],
    );
    const duplicateRow = duplicate.rows[0];
    const duplicateId = duplicateRow?.id;
    if (duplicateId) {
      const changedFields = [
        duplicateRow.title !== title ? 'title' : undefined,
        duplicateRow.body !== body ? 'body' : undefined,
      ].filter((field): field is 'title' | 'body' => Boolean(field));
      await client.query('COMMIT');
      return {
        findingId: duplicateId,
        created: false,
        idempotencyKey: key,
        idempotencyDiff: changedFields.length
          ? {
              message: 'existing finding matched idempotency key, but submitted title/body differed; existing finding returned',
              changedFields,
            }
          : null,
        finding: await queryFindingById(duplicateId),
      };
    }

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id,analysis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id`,
      [analyst, input.kind, title, body, input.confidence, harnessVersionId, projectId, analysis],
    );
    const findingId = inserted.rows[0]?.id;
    if (!findingId) throw new Error('finding insert returned no id');
    for (const item of evidence) {
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [findingId, item.subjectKind, item.sessionId ?? null, item.locator ?? {}, item.subjectId ?? null, item.note ?? null],
      );
    }
    await client.query('COMMIT');
    return {
      findingId,
      created: true,
      evidenceCount: evidence.length,
      idempotencyKey: key,
      finding: await queryFindingById(findingId),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resolveTurn(subjectId: string | undefined, sessionId: string | undefined, locator: JsonRecord) {
  if (subjectId) {
    const byEventId = await queryOne('SELECT * FROM transcript_events WHERE id = $1', [subjectId]);
    if (byEventId) return byEventId;
    const evidence = await queryOne<EvidenceRow>(
      `SELECT *
         FROM finding_evidence
        WHERE subject_kind = 'turn'
          AND subject_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [subjectId],
    );
    if (evidence) {
      sessionId = evidence.session_id ?? sessionId;
      locator = { ...parseLocator(evidence.locator), ...locator };
    }
  }
  const seq = typeof locator.seq === 'number' ? locator.seq : typeof locator.seq === 'string' ? Number(locator.seq) : NaN;
  if (!sessionId || !Number.isFinite(seq)) return null;
  return queryOne(
    `SELECT *
       FROM transcript_events
      WHERE session_id = $1
        AND seq = $2
        AND ($3::text IS NULL OR type = $3)
        AND ($4::text IS NULL OR title = $4)
      ORDER BY id ASC
      LIMIT 1`,
    [sessionId, seq, typeof locator.type === 'string' ? locator.type : null, typeof locator.title === 'string' ? locator.title : null],
  );
}

export async function getEvidenceContext(input: {
  subjectKind: EvidenceSubjectKind;
  subjectId?: string;
  sessionId?: string;
  locator?: JsonRecord;
  evidenceId?: number;
}) {
  assertEvidenceSubjectKind(input.subjectKind);
  let subjectId = cleanString(input.subjectId);
  let sessionId = cleanString(input.sessionId);
  let locator = input.locator ?? {};
  if (input.evidenceId !== undefined) {
    const evidence = await queryOne<EvidenceRow>('SELECT * FROM finding_evidence WHERE id = $1', [input.evidenceId]);
    if (!evidence) throw new Error(`evidence not found: ${input.evidenceId}`);
    subjectId = evidence.subject_id ?? subjectId;
    sessionId = evidence.session_id ?? sessionId;
    locator = { ...parseLocator(evidence.locator), ...locator };
  }

  if (input.subjectKind === 'session') {
    const id = subjectId ?? sessionId;
    if (!id) throw new Error('session evidence context requires subject_id or session_id');
    return {
      subjectKind: input.subjectKind,
      subjectId: id,
      context: await getMcpSessionBundle(id),
    };
  }
  if (input.subjectKind === 'event') {
    if (!subjectId) throw new Error('event evidence context requires subject_id');
    const row = await queryOne('SELECT * FROM transcript_events WHERE id = $1', [subjectId]);
    if (!row) throw new Error(`event not found: ${subjectId}`);
    return { subjectKind: input.subjectKind, subjectId, context: row };
  }
  if (input.subjectKind === 'hunk') {
    if (!subjectId) throw new Error('hunk evidence context requires subject_id');
    const row = await queryOne(
      `SELECT h.*,cf.session_id,cf.path AS file_path,cf.status AS file_status
         FROM diff_hunks h
         JOIN changed_files cf ON cf.id = h.file_id
        WHERE h.id = $1`,
      [subjectId],
    );
    if (!row) throw new Error(`hunk not found: ${subjectId}`);
    return { subjectKind: input.subjectKind, subjectId, context: row };
  }
  if (input.subjectKind === 'pr') {
    if (!subjectId) throw new Error('pr evidence context requires subject_id');
    const row = await queryOne('SELECT * FROM pull_requests WHERE id = $1', [subjectId]);
    if (!row) throw new Error(`pull request not found: ${subjectId}`);
    return { subjectKind: input.subjectKind, subjectId, context: row };
  }

  const row = await resolveTurn(subjectId, sessionId, locator);
  if (!row) throw new Error('turn evidence context could not be resolved');
  return {
    subjectKind: input.subjectKind,
    subjectId: subjectId ?? null,
    sessionId: sessionId ?? null,
    locator,
    context: row,
  };
}
