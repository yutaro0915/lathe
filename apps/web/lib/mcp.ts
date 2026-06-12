import * as crypto from 'node:crypto';
import { getSessionBundle } from './db';
import { getPool, queryOne, queryRows } from './postgres';
import type { SessionBundle } from './types';

export const FINDING_KINDS = ['failure_loop', 'unattributed_diff', 'excess_cost', 'risky_action'] as const;
export const EVIDENCE_SUBJECT_KINDS = ['session', 'event', 'hunk', 'pr', 'turn'] as const;
export const VERDICT_FILTERS = ['accept', 'reject', 'unreviewed', 'any'] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];
export type EvidenceSubjectKind = (typeof EVIDENCE_SUBJECT_KINDS)[number];
export type VerdictFilter = (typeof VERDICT_FILTERS)[number];

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

export interface FindingEvidenceInput {
  subjectKind: EvidenceSubjectKind;
  subjectId?: string;
  sessionId?: string;
  locator?: Record<string, unknown>;
  note?: string;
}

export interface SubmitFindingInput {
  analyst: string;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  projectId?: string;
  harnessVersionId?: string | null;
  evidence: FindingEvidenceInput[];
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

function assertFindingKind(kind: string): asserts kind is FindingKind {
  if (!(FINDING_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid finding kind: ${kind}`);
  }
}

function assertSubjectKind(kind: string): asserts kind is EvidenceSubjectKind {
  if (!(EVIDENCE_SUBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid evidence subject_kind: ${kind}`);
  }
}

function parseLocator(value: EvidenceRow['locator'] | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value;
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
  assertSubjectKind(evidence.subjectKind);
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
  return {
    subjectKind: evidence.subjectKind,
    subjectId,
    sessionId,
    locator,
    note: cleanString(evidence.note),
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

export async function getMcpSessionBundle(sessionId: string): Promise<SessionBundle> {
  const bundle = await getSessionBundle(sessionId);
  if (!bundle) throw new Error(`session not found: ${sessionId}`);
  return bundle;
}

export async function queryFindings(filter: QueryFindingsFilter = {}) {
  if (filter.kind) assertFindingKind(filter.kind);
  if (filter.verdict && !(VERDICT_FILTERS as readonly string[]).includes(filter.verdict)) {
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
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('finding.confidence must be between 0 and 1');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new Error('finding.evidence must contain at least one item');
  }

  const evidence = input.evidence.map(validateEvidenceInput);
  const primary = evidence[0];
  const key = idempotencyKey(analyst, input.kind, primary);
  const inferred = await inferProjectAndHarness(evidence);
  const projectId = cleanString(input.projectId) ?? inferred?.project_id;
  if (!projectId) throw new Error('finding.project_id is required when evidence cannot infer a project');
  const harnessVersionId = input.harnessVersionId === undefined ? inferred?.harness_version_id ?? null : input.harnessVersionId;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE findings, finding_evidence IN SHARE ROW EXCLUSIVE MODE');
    const duplicate = await client.query<{ id: number }>(
      `SELECT f.id
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = $1
          AND f.kind = $2
          AND fe.subject_kind = $3
          AND COALESCE(fe.session_id, '') = $4
          AND COALESCE(fe.subject_id, '') = $5
          AND fe.locator = $6::jsonb
        ORDER BY f.id ASC
        LIMIT 1`,
      [analyst, input.kind, primary.subjectKind, primary.sessionId ?? '', primary.subjectId ?? '', primary.locator ?? {}],
    );
    const duplicateId = duplicate.rows[0]?.id;
    if (duplicateId) {
      await client.query('COMMIT');
      return {
        findingId: duplicateId,
        created: false,
        idempotencyKey: key,
        finding: await queryFindingById(duplicateId),
      };
    }

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [analyst, input.kind, title, body, input.confidence, harnessVersionId, projectId],
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

async function resolveTurn(subjectId: string | undefined, sessionId: string | undefined, locator: Record<string, unknown>) {
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
  locator?: Record<string, unknown>;
  evidenceId?: number;
}) {
  assertSubjectKind(input.subjectKind);
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
