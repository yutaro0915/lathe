// lib/db.ts — Phase 1 read-only data access over Postgres.
//
// Queries return plain rows with snake_case keys; this module maps them to the
// camelCase records declared in lib/types.ts before sending data to clients.

import type {
  Session,
  TranscriptEvent,
  ChangedFile,
  DiffHunk,
  Attribution,
  EventFile,
  Annotation,
  LinkedEvent,
  Runner,
  SessionStatus,
  EventType,
  FileStatus,
  Confidence,
  AttributionMethod,
  EventFileRole,
  AnnotationKind,
  SessionBundle,
  StatsBundle,
  ProjectStat,
  ProjectSessionRef,
  FileStat,
  PullRequest,
  PullRequestBundle,
  PullRequestSessionLink,
  PullRequestState,
  PullRequestSummary,
  Finding,
  FindingEvidence,
  FindingEvidenceExcerpt,
  FindingEvidenceNarrative,
  FindingKind,
  FindingVerdict,
  FindingVerdictValue,
  TurnContext,
  TurnContextEvent,
} from './types';
import { queryOne, queryRows } from './postgres';
import { COST_ANOMALY_BASELINE } from '@lathe/shared';

// ---- raw row shapes (snake_case, as returned by pg) -----------------------

interface SessionRow {
  id: string;
  project: string;
  title: string;
  runner: string;
  model: string | null;
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
  cost_usd: number | null;
  cost_anomaly: boolean;
  cost_anomaly_threshold_usd: number;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  summary: string | null;
  parent_session_id: string | null;
  spawned_by_seq: number | null;
  step_count: number | null;
  seq: number;
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
  harness_provider: string | null;
  harness_content_hash: string | null;
  harness_git_commit: string | null;
  verdict_id: number | null;
  verdict: string | null;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

interface FindingEvidenceRow {
  id: number;
  finding_id: number;
  subject_kind: string;
  session_id: string | null;
  locator: string | Record<string, unknown> | null;
  subject_id: string | null;
  note: string | null;
}

interface FindingVerdictRow {
  id: number;
  finding_id: number;
  verdict: string;
  reason: string | null;
  decided_at: string;
  decided_by: string;
}

interface PullRequestRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  author_login: string | null;
  head_ref_name: string | null;
  head_sha: string | null;
  base_ref_name: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  review_count: number;
  reviews: string | unknown[] | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

interface PullRequestLinkRow extends PullRequestRow {
  link_method: string;
  source: string;
  pr_updated_at: string;
}

interface SessionPrSummaryRow {
  session_id: string;
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
  source: string;
  pr_updated_at: string;
}

interface LinkedEventRow extends TranscriptEventRow {
  __confidence: string;
  __method: string;
  __hunk_id: string;
}

interface PullRequestDiffBundle {
  changedFiles: ChangedFile[];
  hunks: Record<string, DiffHunk[]>;
}

// ---- row -> record mappers ------------------------------------------------

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    runner: r.runner as Runner,
    model: r.model,
    status: r.status as SessionStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    turnCount: r.turn_count,
    toolCount: r.tool_count,
    editCount: r.edit_count,
    bashCount: r.bash_count,
    subagentCount: r.subagent_count,
    errorCount: r.error_count,
    tokenUsage: r.token_usage,
    tokenIn: r.token_in,
    tokenOut: r.token_out,
    gitBranch: r.git_branch,
    commitCount: r.commit_count,
    costUsd: r.cost_usd,
    costAnomaly: r.cost_anomaly,
    costAnomalyThresholdUsd: r.cost_anomaly_threshold_usd,
    costAnomalyGroupSize: r.cost_anomaly_group_size,
    costAnomalyGroupMedianUsd: r.cost_anomaly_group_median_usd,
    summary: r.summary,
    parentSessionId: r.parent_session_id ?? null,
    spawnedBySeq: r.spawned_by_seq ?? null,
    stepCount: r.step_count ?? 0,
    seq: r.seq,
  };
}

function toEvent(r: TranscriptEventRow): TranscriptEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    type: r.type as EventType,
    actor: r.actor,
    title: r.title,
    body: r.body,
    filePath: r.file_path,
    command: r.command,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    tokenUsage: r.token_usage,
    subagent: r.subagent,
    meta: r.meta,
    parentId: r.parent_id,
  };
}

function toChangedFile(r: ChangedFileRow): ChangedFile {
  return {
    id: r.id,
    sessionId: r.session_id,
    path: r.path,
    status: r.status as FileStatus,
    additions: r.additions,
    deletions: r.deletions,
    language: r.language,
    seq: r.seq,
  };
}

function toHunk(r: DiffHunkRow): DiffHunk {
  return {
    id: r.id,
    fileId: r.file_id,
    seq: r.seq,
    header: r.header,
    content: r.content,
  };
}

function toAttribution(r: AttributionRow): Attribution {
  return {
    id: r.id,
    hunkId: r.hunk_id,
    eventId: r.event_id,
    confidence: r.confidence as Confidence,
    method: r.method as AttributionMethod,
    note: r.note,
  };
}

function toEventFile(r: EventFileRow): EventFile {
  return {
    id: r.id,
    eventId: r.event_id,
    path: r.path,
    role: r.role as EventFileRole,
  };
}

function toAnnotation(r: AnnotationRow): Annotation {
  return {
    id: r.id,
    sessionId: r.session_id,
    atSeq: r.at_seq,
    kind: r.kind as AnnotationKind,
    note: r.note,
  };
}

function parseLocator(value: FindingEvidenceRow['locator']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toFindingEvidence(r: FindingEvidenceRow): FindingEvidence {
  return {
    id: r.id,
    findingId: r.finding_id,
    subjectKind: r.subject_kind as FindingEvidence['subjectKind'],
    sessionId: r.session_id,
    locator: parseLocator(r.locator),
    subjectId: r.subject_id,
    note: r.note,
    excerpt: null,
  };
}

function toFindingVerdict(row: FindingVerdictRow): FindingVerdict {
  return {
    id: row.id,
    findingId: row.finding_id,
    verdict: row.verdict as FindingVerdictValue,
    reason: row.reason,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

// Read a numeric locator key (analyst-engine writes turn/event evidence as
// {"seq": <event seq>}; older fixtures may use seq under different keys).
function locatorSeq(locator: Record<string, unknown>): number | null {
  for (const key of ['seq', 'at_seq', 'step']) {
    const value = locator[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

const EVIDENCE_EXCERPT_CHARS = 300;
const EVIDENCE_NARRATIVE_CHARS = 200;

function truncateExcerpt(value: string | null): string | null {
  return truncateTo(value, EVIDENCE_EXCERPT_CHARS);
}

function truncateTo(value: string | null, chars: number): string | null {
  if (value == null) return null;
  const compact = value.replace(/\s+$/g, '');
  if (!compact) return null;
  return compact.length <= chars ? compact : `${compact.slice(0, chars - 1)}…`;
}

// One line of a body/title, trimmed — used for the trigger / aftermath summaries
// where a single readable line beats a multi-line dump.
function firstLine(value: string | null): string | null {
  if (value == null) return null;
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}

interface EvidenceEventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  title: string;
  command: string | null;
  body: string | null;
  exit_code: number | null;
}

// Lightweight event shape used to reconstruct the narrative (trigger / position /
// aftermath) for a session — fetched once per involved session, not per evidence.
interface NarrativeEventRow {
  session_id: string;
  seq: number;
  ts: string;
  type: string;
  title: string;
  body: string | null;
  exit_code: number | null;
}

interface NarrativeSessionRow {
  id: string;
  title: string;
  runner: string;
  model: string | null;
  started_at: string;
  turn_count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// HH:MM:SS → ms-of-day (mirrors SessionViewer.hmsToMs so the position label and
// the transcript agree on elapsed time). Returns null when no time is present.
function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

// Whole minutes from the first event to the event at `targetSeq`. The `ts`
// column is wall-clock with no date, so a long run wraps past midnight; walk the
// ordered events and add a day each time the clock goes backwards. Returns null
// when the timestamps can't be parsed or the target isn't found.
function elapsedMinutesToSeq(events: NarrativeEventRow[], targetSeq: number): number | null {
  const firstMs = tsToMs(events[0]?.ts);
  if (firstMs == null) return null;
  let prevMs = firstMs;
  let dayOffset = 0;
  for (const e of events) {
    const cur = tsToMs(e.ts);
    if (cur != null) {
      if (cur < prevMs) dayOffset += DAY_MS; // crossed midnight since the previous event
      prevMs = cur;
    }
    if (e.seq === targetSeq) {
      if (cur == null) return null;
      const elapsed = dayOffset + cur - firstMs;
      return Math.max(0, Math.round(elapsed / 60000));
    }
  }
  return null;
}

// Resolve the現物 (transcript event + short excerpt) for every event/turn
// evidence in one batched pass — never per-evidence (no N+1). Evidence resolves
// either by its subject_id (event id) or by session_id + locator.seq. After the
// excerpt is attached, a SECOND batched pass adds the narrative context
// (session / trigger / position / aftermath) keyed by the resolved (session,seq).
async function attachEvidenceExcerpts(
  evidence: FindingEvidence[],
  findingKindById: Map<number, FindingKind>,
): Promise<void> {
  const byEventId: FindingEvidence[] = [];
  const bySeq: FindingEvidence[] = [];
  const eventIds = new Set<string>();
  const seqPairs: Array<{ sessionId: string; seq: number }> = [];
  const seenSeqPair = new Set<string>();

  for (const item of evidence) {
    if (item.subjectKind !== 'event' && item.subjectKind !== 'turn') continue;
    if (item.subjectId) {
      byEventId.push(item);
      eventIds.add(item.subjectId);
      continue;
    }
    const seq = locatorSeq(item.locator);
    if (item.sessionId && seq != null) {
      bySeq.push(item);
      const key = `${item.sessionId} ${seq}`;
      if (!seenSeqPair.has(key)) {
        seenSeqPair.add(key);
        seqPairs.push({ sessionId: item.sessionId, seq });
      }
    }
  }

  if (eventIds.size === 0 && seqPairs.length === 0) return;

  const byId = new Map<string, EvidenceEventRow>();
  const bySessionSeq = new Map<string, EvidenceEventRow>();

  if (eventIds.size > 0) {
    const rows = await queryRows<EvidenceEventRow>(
      `SELECT id, session_id, seq, type, title, command, body, exit_code
         FROM transcript_events
        WHERE id = ANY($1::text[])`,
      [[...eventIds]],
    );
    for (const row of rows) byId.set(row.id, row);
  }

  if (seqPairs.length > 0) {
    const rows = await queryRows<EvidenceEventRow>(
      `SELECT te.id, te.session_id, te.seq, te.type, te.title, te.command, te.body, te.exit_code
         FROM transcript_events te
         JOIN unnest($1::text[], $2::int[]) AS req(session_id, seq)
           ON req.session_id = te.session_id AND req.seq = te.seq`,
      [seqPairs.map((p) => p.sessionId), seqPairs.map((p) => p.seq)],
    );
    for (const row of rows) bySessionSeq.set(`${row.session_id} ${row.seq}`, row);
  }

  const toExcerpt = (row: EvidenceEventRow): FindingEvidenceExcerpt => ({
    eventId: row.id,
    seq: row.seq,
    type: row.type,
    title: row.title,
    command: truncateExcerpt(row.command),
    output: truncateExcerpt(row.body),
    exitCode: row.exit_code,
    narrative: null,
  });

  // session that each resolved evidence belongs to (from the resolved event row,
  // which always carries session_id even when the evidence row's sessionId was
  // null) — used to drive the narrative pass.
  const targetSessionByEvidence = new Map<number, string>();

  for (const item of byEventId) {
    const row = item.subjectId ? byId.get(item.subjectId) : undefined;
    if (row) {
      item.excerpt = toExcerpt(row);
      targetSessionByEvidence.set(item.id, row.session_id);
    }
  }
  for (const item of bySeq) {
    const seq = locatorSeq(item.locator);
    const row = item.sessionId && seq != null ? bySessionSeq.get(`${item.sessionId} ${seq}`) : undefined;
    if (row) {
      item.excerpt = toExcerpt(row);
      targetSessionByEvidence.set(item.id, row.session_id);
    }
  }

  await attachEvidenceNarrative(evidence, targetSessionByEvidence, findingKindById);
}

// Second batched pass: for every evidence whose excerpt resolved, attach the
// surrounding story. All transcript_events for the involved sessions are fetched
// ONCE (one query for every session, not one per evidence), then trigger /
// position / aftermath are computed in-process.
async function attachEvidenceNarrative(
  evidence: FindingEvidence[],
  targetSessionByEvidence: Map<number, string>,
  findingKindById: Map<number, FindingKind>,
): Promise<void> {
  if (targetSessionByEvidence.size === 0) return;
  const sessionIds = new Set<string>(targetSessionByEvidence.values());

  const [sessionRows, eventRows] = await Promise.all([
    queryRows<NarrativeSessionRow>(
      `SELECT id, title, runner, model, started_at, turn_count
         FROM sessions
        WHERE id = ANY($1::text[])`,
      [[...sessionIds]],
    ),
    queryRows<NarrativeEventRow>(
      `SELECT session_id, seq, ts, type, title, body, exit_code
         FROM transcript_events
        WHERE session_id = ANY($1::text[])
          AND parent_id IS NULL
        ORDER BY session_id ASC, seq ASC`,
      [[...sessionIds]],
    ),
  ]);

  const sessionById = new Map<string, NarrativeSessionRow>();
  for (const row of sessionRows) sessionById.set(row.id, row);

  const eventsBySession = new Map<string, NarrativeEventRow[]>();
  for (const row of eventRows) {
    const arr = eventsBySession.get(row.session_id);
    if (arr) arr.push(row);
    else eventsBySession.set(row.session_id, [row]);
  }

  for (const item of evidence) {
    if (!item.excerpt) continue;
    const sessionId = targetSessionByEvidence.get(item.id);
    if (!sessionId) continue;
    const session = sessionById.get(sessionId);
    const events = eventsBySession.get(sessionId);
    if (!session || !events) continue;
    const kind = findingKindById.get(item.findingId);
    item.excerpt.narrative = buildNarrative(session, events, item.excerpt.seq, kind);
  }
}

function buildNarrative(
  session: NarrativeSessionRow,
  events: NarrativeEventRow[],
  targetSeq: number,
  kind: FindingKind | undefined,
): FindingEvidenceNarrative {
  // position in the run: 1-based turn (count of user_message at/before target),
  // total turns, and whole minutes from the session's first event to this step.
  let turn: number | null = null;
  let turnSoFar = 0;
  for (const e of events) {
    if (e.type === 'user_message') turnSoFar += 1;
    if (e.seq === targetSeq) {
      turn = turnSoFar > 0 ? turnSoFar : null;
      break;
    }
  }

  // elapsed minutes from the first event to the target. The `ts` column is a
  // wall clock (HH:MM:SS) with no date, so a multi-day run wraps at midnight;
  // accumulate by walking forward and adding a day each time the clock goes
  // backwards, mirroring the transcript's own day-wrap handling.
  const minutesFromStart = elapsedMinutesToSeq(events, targetSeq);

  // trigger: the nearest preceding user_message (the request this stretch of
  // work answers). Falls through to the first user_message of the run.
  let trigger: FindingEvidenceNarrative['trigger'] = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.seq <= targetSeq && e.type === 'user_message') {
      const text = truncateTo(firstLine(e.body) ?? e.title, EVIDENCE_NARRATIVE_CHARS);
      if (text) trigger = { seq: e.seq, text };
      break;
    }
  }

  const aftermath = buildAftermath(events, targetSeq, kind);

  return {
    sessionId: session.id,
    sessionTitle: session.title,
    runner: session.runner,
    model: session.model,
    startedAt: session.started_at,
    turn,
    turnCount: session.turn_count ?? null,
    minutesFromStart,
    trigger,
    aftermath,
  };
}

const FAILURE_TYPES = new Set(['bash', 'test', 'error', 'hook']);

function isFailure(e: NarrativeEventRow): boolean {
  return e.type === 'error' || (e.exit_code != null && e.exit_code !== 0);
}

// "結末" — what the run did after this step. For failure_loop findings we walk to
// the LAST failure in the contiguous run of failures, then take the first
// non-failure event after it (the escape). Otherwise we take the next
// assistant/user message after the target step.
function buildAftermath(
  events: NarrativeEventRow[],
  targetSeq: number,
  kind: FindingKind | undefined,
): FindingEvidenceNarrative['aftermath'] {
  const idx = events.findIndex((e) => e.seq === targetSeq);
  if (idx < 0) return null;

  const summarize = (e: NarrativeEventRow): FindingEvidenceNarrative['aftermath'] => {
    const text = truncateTo(firstLine(e.body) ?? e.title, EVIDENCE_NARRATIVE_CHARS);
    if (!text) return null;
    return { seq: e.seq, type: e.type, text };
  };

  if (kind === 'failure_loop' && FAILURE_TYPES.has(events[idx].type)) {
    // advance through the contiguous block of failing tool calls
    let last = idx;
    for (let i = idx; i < events.length; i += 1) {
      if (isFailure(events[i])) last = i;
      else break;
    }
    // the first non-failure event after the failure block = how it ended
    for (let i = last + 1; i < events.length; i += 1) {
      if (!isFailure(events[i])) return summarize(events[i]);
    }
    // no escape captured — fall back to the last failure itself
    return summarize(events[last]);
  }

  for (let i = idx + 1; i < events.length; i += 1) {
    const e = events[i];
    if (e.type === 'assistant_message' || e.type === 'user_message') return summarize(e);
  }
  // nothing textual after — use the immediate next event if any
  return idx + 1 < events.length ? summarize(events[idx + 1]) : null;
}

function toFinding(row: FindingRow, evidence: FindingEvidence[]): Finding {
  const verdict: FindingVerdict | null =
    row.verdict_id == null || row.verdict == null || row.decided_at == null || row.decided_by == null
      ? null
      : {
          id: row.verdict_id,
          findingId: row.id,
          verdict: row.verdict as FindingVerdictValue,
          reason: row.reason,
          decidedAt: row.decided_at,
          decidedBy: row.decided_by,
        };
  return {
    id: row.id,
    createdAt: row.created_at,
    analyst: row.analyst,
    kind: row.kind as FindingKind,
    title: row.title,
    body: row.body,
    confidence: row.confidence,
    harnessVersionId: row.harness_version_id,
    harnessProvider: row.harness_provider,
    harnessContentHash: row.harness_content_hash,
    harnessGitCommit: row.harness_git_commit,
    projectId: row.project_id,
    evidence,
    verdict,
  };
}

function parseReviews(value: PullRequestRow['reviews']): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toPullRequestSummary(r: PullRequestRow | SessionPrSummaryRow, linkMethod?: string): PullRequestSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    title: r.title,
    state: r.state as PullRequestState,
    url: r.url,
    headRefName: r.head_ref_name,
    baseRefName: 'base_ref_name' in r ? r.base_ref_name : undefined,
    additions: 'additions' in r ? r.additions : undefined,
    deletions: 'deletions' in r ? r.deletions : undefined,
    changedFiles: 'changed_files' in r ? r.changed_files : undefined,
    mergedAt: r.merged_at,
    updatedAt: r.updated_at,
    linkMethod: linkMethod ? (linkMethod as 'sha' | 'branch') : undefined,
  };
}

function toPullRequest(r: PullRequestRow): PullRequest {
  return {
    ...toPullRequestSummary(r),
    body: r.body,
    authorLogin: r.author_login,
    headSha: r.head_sha,
    baseRefName: r.base_ref_name,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changed_files,
    reviewCount: r.review_count,
    reviews: parseReviews(r.reviews),
    createdAt: r.created_at,
  };
}

// ---- session queries -------------------------------------------------------

const COST_ANOMALY_PARAMS = [
  COST_ANOMALY_BASELINE.minimumGroupSize,
  COST_ANOMALY_BASELINE.absoluteFloorUsd,
  COST_ANOMALY_BASELINE.medianMultiplier,
] as const;

const SESSIONS_WITH_COST_ANOMALY = `
  WITH event_counts AS (
    SELECT session_id,
           COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS step_count
      FROM transcript_events
     GROUP BY session_id
  ),
  cost_baseline AS (
    SELECT runner,
           COUNT(cost_usd)::int AS cost_anomaly_group_size,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS cost_anomaly_group_median_usd
      FROM sessions
     WHERE cost_usd IS NOT NULL
     GROUP BY runner
  ),
  scored_sessions AS (
    SELECT s.*,
           COALESCE(b.cost_anomaly_group_size, 0)::int AS cost_anomaly_group_size,
           b.cost_anomaly_group_median_usd,
           CASE
             WHEN s.cost_usd IS NULL THEN $2::float8
             WHEN COALESCE(b.cost_anomaly_group_size, 0) < $1::int THEN $2::float8
             WHEN b.cost_anomaly_group_median_usd IS NULL THEN $2::float8
             ELSE GREATEST(b.cost_anomaly_group_median_usd * $3::float8, $2::float8)
           END AS cost_anomaly_threshold_usd
      FROM sessions s
      LEFT JOIN cost_baseline b ON b.runner = s.runner
  )
  SELECT scored_sessions.*,
         COALESCE(event_counts.step_count, 0)::int AS step_count,
         (
           cost_usd IS NOT NULL
           AND cost_usd > cost_anomaly_threshold_usd
         ) AS cost_anomaly
    FROM scored_sessions
    LEFT JOIN event_counts ON event_counts.session_id = scored_sessions.id
`;

export async function getPrimarySession(): Promise<Session> {
  const row = await queryOne<SessionRow>(
    `${SESSIONS_WITH_COST_ANOMALY} WHERE seq = $4 AND parent_session_id IS NULL LIMIT 1`,
    [...COST_ANOMALY_PARAMS, 1],
  );
  if (row) return toSession(row);

  const first = await queryOne<SessionRow>(
    `${SESSIONS_WITH_COST_ANOMALY} WHERE parent_session_id IS NULL ORDER BY seq ASC LIMIT 1`,
    [...COST_ANOMALY_PARAMS],
  );
  if (first) return toSession(first);

  const anySession = await queryOne<SessionRow>(
    `${SESSIONS_WITH_COST_ANOMALY} ORDER BY seq ASC LIMIT 1`,
    [...COST_ANOMALY_PARAMS],
  );
  if (!anySession) {
    throw new Error('No sessions found. Run `pnpm ingest` first.');
  }
  return toSession(anySession);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const row = await queryOne<SessionRow>(
    `${SESSIONS_WITH_COST_ANOMALY} WHERE id = $4`,
    [...COST_ANOMALY_PARAMS, id],
  );
  return row ? toSession(row) : undefined;
}

export async function listSessions(): Promise<Session[]> {
  const rows = await queryRows<SessionRow>(
    `${SESSIONS_WITH_COST_ANOMALY} ORDER BY seq ASC`,
    [...COST_ANOMALY_PARAMS],
  );
  return rows.map(toSession);
}

// ---- pull request queries --------------------------------------------------

export async function listPullRequests(): Promise<PullRequestSummary[]> {
  const rows = await queryRows<PullRequestRow>(
    `SELECT *
       FROM pull_requests
      ORDER BY updated_at DESC, project_id ASC, number DESC`,
  );
  return rows.map((row) => toPullRequestSummary(row));
}

export async function getPullRequest(id: string): Promise<PullRequest | undefined> {
  const row = await queryOne<PullRequestRow>('SELECT * FROM pull_requests WHERE id = $1', [id]);
  return row ? toPullRequest(row) : undefined;
}

export async function getPullRequestsForSession(sessionId: string): Promise<PullRequestSummary[]> {
  const rows = await queryRows<PullRequestLinkRow>(
    `SELECT pr.*, spr.source AS link_method, spr.source, spr.pr_updated_at
       FROM session_pull_requests spr
       JOIN pull_requests pr ON pr.id = spr.pr_id
      WHERE spr.session_id = $1
      ORDER BY spr.pr_updated_at DESC, pr.number DESC`,
    [sessionId],
  );
  return rows.map((row) => toPullRequestSummary(row, row.link_method));
}

export async function getSessionPrSummary(): Promise<Record<string, PullRequestSummary[]>> {
  const rows = await queryRows<SessionPrSummaryRow>(
    `SELECT spr.session_id,
            pr.id, pr.project_id, pr.number, pr.title, pr.state, pr.url,
            pr.head_ref_name, pr.merged_at, pr.updated_at, spr.source AS link_method, spr.source, spr.pr_updated_at
       FROM session_pull_requests spr
       JOIN pull_requests pr ON pr.id = spr.pr_id
      ORDER BY spr.pr_updated_at DESC, pr.number DESC`,
  );
  const out: Record<string, PullRequestSummary[]> = {};
  for (const row of rows) (out[row.session_id] ??= []).push(toPullRequestSummary(row, row.link_method));
  return out;
}

export async function getSessionsForPullRequest(prId: string): Promise<PullRequestSessionLink[]> {
  const rows = await queryRows<SessionRow & { link_method: string; matched_sha: string | null }>(
    `SELECT s.*, spr.source AS link_method,
            (
              SELECT pc.sha
                FROM pr_commits pc
                JOIN session_commits sc
                  ON sc.session_id = s.id
                 AND LENGTH(sc.sha) >= 7
                 AND LOWER(pc.sha) LIKE LOWER(sc.sha) || '%'
               WHERE pc.pr_id = spr.pr_id
               ORDER BY LENGTH(sc.sha) DESC, pc.sha ASC
               LIMIT 1
            ) AS matched_sha
       FROM session_pull_requests spr
       JOIN sessions s ON s.id = spr.session_id
      WHERE spr.pr_id = $1
      ORDER BY spr.pr_updated_at DESC, s.seq ASC`,
    [prId],
  );
  return rows.map((row) => ({
    session: toSession(row),
    linkMethod: row.link_method as 'sha' | 'branch',
    matchedSha: row.matched_sha,
  }));
}

export async function getPullRequestBundle(id: string): Promise<PullRequestBundle | undefined> {
  const pullRequest = await getPullRequest(id);
  if (!pullRequest) return undefined;
  const linkedSessions = await getSessionsForPullRequest(id);
  const diff = await getPullRequestLinkedDiff(linkedSessions.map((link) => link.session.id));
  return {
    pullRequest,
    linkedSessions,
    changedFiles: diff.changedFiles,
    hunks: diff.hunks,
  };
}

async function getPullRequestLinkedDiff(sessionIds: string[]): Promise<PullRequestDiffBundle> {
  if (sessionIds.length === 0) return { changedFiles: [], hunks: {} };

  const fileRows = await queryRows<ChangedFileRow>(
    `SELECT *
       FROM changed_files
      WHERE session_id = ANY($1::text[])
      ORDER BY session_id ASC, seq ASC`,
    [sessionIds],
  );
  const changedFiles = fileRows.map(toChangedFile);
  const fileIds = changedFiles.map((file) => file.id);
  if (fileIds.length === 0) return { changedFiles, hunks: {} };

  const hunkRows = await queryRows<DiffHunkRow>(
    `SELECT *
       FROM diff_hunks
      WHERE file_id = ANY($1::text[])
      ORDER BY file_id ASC, seq ASC`,
    [fileIds],
  );
  const hunks: Record<string, DiffHunk[]> = {};
  for (const row of hunkRows) {
    const hunk = toHunk(row);
    (hunks[hunk.fileId] ??= []).push(hunk);
  }
  return { changedFiles, hunks };
}

// ---- transcript event queries ---------------------------------------------

export async function getEvents(sessionId: string): Promise<TranscriptEvent[]> {
  const rows = await queryRows<TranscriptEventRow>(
    'SELECT * FROM transcript_events WHERE session_id = $1 ORDER BY seq ASC, parent_id NULLS FIRST, id ASC',
    [sessionId],
  );
  return rows.map(toEvent);
}

// The transcript of ONE turn (Findings triage embedded transcript). A turn is
// the stretch of top-level events from the Nth user_message (inclusive) up to —
// but not including — the (N+1)th user_message, mirroring buildNarrative's turn
// numbering (count of user_message at/before a seq). Sub-agent children are
// excluded (parent_id IS NULL) so the inline row count stays bounded, and the
// output is capped at TURN_CONTEXT_EVENT_CAP rows with command/output truncated
// so the payload is small. `evidenceSeqs` flags the finding's own steps.
const TURN_CONTEXT_EVENT_CAP = 200;
const TURN_CONTEXT_TEXT_CHARS = 200;

export async function getTurnContext(
  sessionId: string,
  turn: number,
  evidenceSeqs: number[] = [],
): Promise<TurnContext | undefined> {
  if (!Number.isInteger(turn) || turn < 1) return undefined;
  const session = await queryOne<NarrativeSessionRow>(
    `SELECT id, title, runner, model, started_at, turn_count
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) return undefined;

  // top-level events in seq order; we walk them to find the turn's seq span.
  const rows = await queryRows<TranscriptEventRow>(
    `SELECT * FROM transcript_events
      WHERE session_id = $1 AND parent_id IS NULL
      ORDER BY seq ASC, id ASC`,
    [sessionId],
  );

  // locate the Nth and (N+1)th user_message → [headSeq, nextSeq)
  let seen = 0;
  let headSeq: number | null = null;
  let nextSeq: number | null = null;
  for (const r of rows) {
    if (r.type !== 'user_message') continue;
    seen += 1;
    if (seen === turn) headSeq = r.seq;
    else if (seen === turn + 1) {
      nextSeq = r.seq;
      break;
    }
  }
  if (headSeq == null) return undefined;

  const inTurn = rows.filter(
    (r) => r.seq >= headSeq! && (nextSeq == null || r.seq < nextSeq),
  );
  const totalEvents = inTurn.length;
  const truncated = totalEvents > TURN_CONTEXT_EVENT_CAP;
  const evidenceSet = new Set(evidenceSeqs);

  const events: TurnContextEvent[] = inTurn
    .slice(0, TURN_CONTEXT_EVENT_CAP)
    .map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type as EventType,
      actor: r.actor,
      title: r.title,
      text: truncateTo(firstLine(r.body) ?? r.title, TURN_CONTEXT_TEXT_CHARS),
      command: truncateExcerpt(r.command),
      output: truncateExcerpt(r.body && r.command ? r.body : null),
      exitCode: r.exit_code,
      isEvidence: evidenceSet.has(r.seq),
    }));

  return {
    sessionId: session.id,
    sessionTitle: session.title,
    turn,
    turnCount: session.turn_count ?? events.length,
    headSeq,
    events,
    truncated,
    totalEvents,
  };
}

export async function getEvent(id: string): Promise<TranscriptEvent | undefined> {
  const row = await queryOne<TranscriptEventRow>('SELECT * FROM transcript_events WHERE id = $1', [id]);
  return row ? toEvent(row) : undefined;
}

export async function getEventFiles(eventId: string): Promise<EventFile[]> {
  const rows = await queryRows<EventFileRow>(
    'SELECT * FROM event_files WHERE event_id = $1 ORDER BY id ASC',
    [eventId],
  );
  return rows.map(toEventFile);
}

export async function getAnnotations(sessionId: string): Promise<Annotation[]> {
  const rows = await queryRows<AnnotationRow>(
    'SELECT * FROM annotations WHERE session_id = $1 ORDER BY at_seq ASC',
    [sessionId],
  );
  return rows.map(toAnnotation);
}

export async function listFindings(): Promise<Finding[]> {
  const rows = await queryRows<FindingRow>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id)
              id, finding_id, verdict, reason, decided_at, decided_by
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.id, f.created_at, f.analyst, f.kind, f.title, f.body, f.confidence,
            f.harness_version_id, f.project_id,
            hv.provider AS harness_provider,
            hv.content_hash AS harness_content_hash,
            hv.git_commit AS harness_git_commit,
            v.id AS verdict_id,
            v.verdict,
            v.reason,
            v.decided_at,
            v.decided_by
       FROM findings f
       LEFT JOIN harness_versions hv ON hv.id = f.harness_version_id
       LEFT JOIN latest_verdict v ON v.finding_id = f.id
      ORDER BY
            CASE WHEN v.id IS NULL THEN 0 ELSE 1 END ASC,
            f.confidence DESC,
            f.created_at DESC,
            f.id DESC`,
  );
  if (rows.length === 0) return [];

  const evidenceRows = await queryRows<FindingEvidenceRow>(
    `SELECT id, finding_id, subject_kind, session_id, locator, subject_id, note
       FROM finding_evidence
      WHERE finding_id = ANY($1::int[])
      ORDER BY finding_id ASC, id ASC`,
    [rows.map((row) => row.id)],
  );
  const allEvidence = evidenceRows.map(toFindingEvidence);
  const findingKindById = new Map<number, FindingKind>(
    rows.map((row) => [row.id, row.kind as FindingKind]),
  );
  await attachEvidenceExcerpts(allEvidence, findingKindById);

  const evidenceByFinding = new Map<number, FindingEvidence[]>();
  for (const item of allEvidence) {
    const arr = evidenceByFinding.get(item.findingId);
    if (arr) arr.push(item);
    else evidenceByFinding.set(item.findingId, [item]);
  }

  return rows.map((row) => toFinding(row, evidenceByFinding.get(row.id) ?? []));
}

// ---- finding writes --------------------------------------------------------

export async function insertFindingVerdict(
  findingId: number,
  verdict: FindingVerdictValue,
  reason: string | null,
): Promise<FindingVerdict | undefined> {
  const row = await queryOne<FindingVerdictRow>(
    `INSERT INTO finding_verdicts (finding_id, verdict, reason)
     VALUES ($1, $2, $3)
     RETURNING id, finding_id, verdict, reason, decided_at, decided_by`,
    [findingId, verdict, reason],
  );
  return row ? toFindingVerdict(row) : undefined;
}

export async function deleteFindingVerdict(findingId: number, verdictId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `DELETE FROM finding_verdicts
      WHERE finding_id = $1
        AND id = $2
      RETURNING id`,
    [findingId, verdictId],
  );
  return Boolean(row);
}

export async function updateFindingAnalysisIfMissing(
  findingId: number,
  analysis: Record<string, unknown>,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `UPDATE findings
        SET analysis = $2::jsonb
      WHERE id = $1
        AND analysis IS NULL
      RETURNING id`,
    [findingId, analysis],
  );
  return Boolean(row);
}

// ---- git diff queries ------------------------------------------------------

export async function getChangedFiles(sessionId: string): Promise<ChangedFile[]> {
  const rows = await queryRows<ChangedFileRow>(
    'SELECT * FROM changed_files WHERE session_id = $1 ORDER BY seq ASC',
    [sessionId],
  );
  return rows.map(toChangedFile);
}

export async function getHunks(fileId: string): Promise<DiffHunk[]> {
  const rows = await queryRows<DiffHunkRow>(
    'SELECT * FROM diff_hunks WHERE file_id = $1 ORDER BY seq ASC',
    [fileId],
  );
  return rows.map(toHunk);
}

export async function getAttributionsForHunk(hunkId: string): Promise<Attribution[]> {
  const rows = await queryRows<AttributionRow>(
    'SELECT * FROM attributions WHERE hunk_id = $1 ORDER BY id ASC',
    [hunkId],
  );
  return rows.map(toAttribution);
}

// ---- attribution join (screen B "Linked Events") --------------------------

export async function getLinkedEventsForFile(fileId: string): Promise<LinkedEvent[]> {
  const rows = await queryRows<LinkedEventRow>(
    `SELECT e.*,
            a.confidence AS __confidence,
            a.method     AS __method,
            a.hunk_id    AS __hunk_id
       FROM attributions a
       JOIN diff_hunks   h ON h.id = a.hunk_id
       JOIN transcript_events e ON e.id = a.event_id
      WHERE h.file_id = $1
        AND a.event_id IS NOT NULL
      ORDER BY h.seq ASC, e.seq ASC`,
    [fileId],
  );

  return rows.map((r) => ({
    event: toEvent(r),
    confidence: r.__confidence as Confidence,
    method: r.__method as AttributionMethod,
    hunkId: r.__hunk_id,
  }));
}

// ---- aggregates ------------------------------------------------------------

export async function countEventsByType(sessionId: string): Promise<Record<string, number>> {
  const rows = await queryRows<{ type: string; n: number }>(
    `SELECT type, COUNT(*)::int AS n
       FROM transcript_events
      WHERE session_id = $1
        AND parent_id IS NULL
      GROUP BY type`,
    [sessionId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = r.n;
  return out;
}

// ---- full per-session bundle (for the interactive client) ------------------

export async function getSessionBundle(id: string): Promise<SessionBundle | undefined> {
  const session = await getSession(id);
  if (!session) return undefined;

  const [events, typeCounts, annotations, changedFiles, pullRequests] = await Promise.all([
    getEvents(id),
    countEventsByType(id),
    getAnnotations(id),
    getChangedFiles(id),
    getPullRequestsForSession(id),
  ]);

  // Batched fan-out (issue #8): one query each for event-files / hunks /
  // attributions / linked-events, keyed by the event & file id lists. This
  // replaces the previous per-event + per-file + per-hunk N+1 round-trips that
  // dominated server render time for large sessions (a session with hundreds of
  // events issued hundreds of getEventFiles queries alone). Output shape is
  // identical to the per-item version, so the client is unaffected.
  const eventIds = events.map((e) => e.id);
  const fileIds = changedFiles.map((f) => f.id);

  const [eventFileRows, hunkRows, attrRows, linkedRows] = await Promise.all([
    eventIds.length
      ? queryRows<EventFileRow>(
          `SELECT * FROM event_files WHERE event_id = ANY($1::text[]) ORDER BY event_id ASC, id ASC`,
          [eventIds],
        )
      : Promise.resolve([] as EventFileRow[]),
    fileIds.length
      ? queryRows<DiffHunkRow>(
          `SELECT * FROM diff_hunks WHERE file_id = ANY($1::text[]) ORDER BY file_id ASC, seq ASC`,
          [fileIds],
        )
      : Promise.resolve([] as DiffHunkRow[]),
    fileIds.length
      ? queryRows<AttributionRow & { file_id: string }>(
          `SELECT a.*, h.file_id
             FROM attributions a
             JOIN diff_hunks h ON h.id = a.hunk_id
            WHERE h.file_id = ANY($1::text[])
            ORDER BY a.hunk_id ASC, a.id ASC`,
          [fileIds],
        )
      : Promise.resolve([] as (AttributionRow & { file_id: string })[]),
    fileIds.length
      ? queryRows<LinkedEventRow & { __file_id: string }>(
          `SELECT e.*,
                  a.confidence AS __confidence,
                  a.method     AS __method,
                  a.hunk_id    AS __hunk_id,
                  h.file_id    AS __file_id
             FROM attributions a
             JOIN diff_hunks   h ON h.id = a.hunk_id
             JOIN transcript_events e ON e.id = a.event_id
            WHERE h.file_id = ANY($1::text[])
              AND a.event_id IS NOT NULL
            ORDER BY h.file_id ASC, h.seq ASC, e.seq ASC`,
          [fileIds],
        )
      : Promise.resolve([] as (LinkedEventRow & { __file_id: string })[]),
  ]);

  // event-files: keyed by eventId (only events that actually touched a file)
  const eventFiles: Record<string, EventFile[]> = {};
  for (const row of eventFileRows) (eventFiles[row.event_id] ??= []).push(toEventFile(row));

  // hunks: keyed by fileId; every changed file gets an entry (possibly empty)
  const hunks: Record<string, DiffHunk[]> = {};
  for (const f of changedFiles) hunks[f.id] = [];
  for (const row of hunkRows) (hunks[row.file_id] ??= []).push(toHunk(row));

  // attributions: keyed by hunkId; every hunk gets an entry (possibly empty),
  // preserving the per-hunk array the previous per-hunk fetch produced.
  const attributions: Record<string, Attribution[]> = {};
  for (const list of Object.values(hunks)) for (const h of list) attributions[h.id] = [];
  for (const row of attrRows) (attributions[row.hunk_id] ??= []).push(toAttribution(row));

  // linked events: keyed by fileId; every changed file gets an entry.
  const linkedEvents: Record<string, LinkedEvent[]> = {};
  for (const f of changedFiles) linkedEvents[f.id] = [];
  for (const row of linkedRows) {
    (linkedEvents[row.__file_id] ??= []).push({
      event: toEvent(row),
      confidence: row.__confidence as Confidence,
      method: row.__method as AttributionMethod,
      hunkId: row.__hunk_id,
    });
  }

  return {
    session,
    pullRequests,
    events,
    typeCounts,
    annotations,
    eventFiles,
    changedFiles,
    hunks,
    attributions,
    linkedEvents,
  };
}

// ---- cross-session stats (the /overview page) -----------------------------

function deriveProjectKey(path: string, repoBasename: string): string {
  const marker = `/${repoBasename}/`;
  const idx = repoBasename ? path.indexOf(marker) : -1;
  if (idx < 0) {
    if (path.includes('/.claude/')) return '(.claude config)';
    return '(external)';
  }
  const rel = path.slice(idx + marker.length);
  const segs = rel.split('/').filter(Boolean);
  if (segs.length <= 1) return '(repo root)';
  if (segs[0] === 'projects' && segs.length >= 2) return `projects/${segs[1]}`;
  return segs[0];
}

interface StatSessionRow {
  id: string;
  title: string;
  project: string;
  model: string | null;
  duration_ms: number | null;
  token_usage: number;
  cost_usd: number | null;
  error_count: number;
}

// The per-project rollup ONLY — the just-the-projects slice of getStats, used by
// the session viewer's sidebar project picker (issue #8). The full getStats also
// runs 5 extra GROUP BY aggregates (skills / subagents / memory / hooks / models)
// and a top-60 file-stat pass, none of which the viewer renders; computing those
// on every cross-session navigation was wasted server work. This shares the same
// sessions + changed_files scan and project-grouping logic, nothing more.
export async function getProjectStats(): Promise<ProjectStat[]> {
  const [sessions, fileRows] = await Promise.all([
    queryRows<StatSessionRow>(
      'SELECT id, title, project, model, duration_ms, token_usage, cost_usd, error_count FROM sessions ORDER BY seq ASC',
    ),
    queryRows<{ session_id: string; path: string; additions: number; deletions: number }>(
      'SELECT session_id, path, additions, deletions FROM changed_files',
    ),
  ]);
  return buildProjectStats(sessions, fileRows);
}

// Shared project-grouping pass (used by getProjectStats and getStats). For each
// session, attribute it to the project that owns the most of its changed files,
// then roll the session's metrics into that project bucket.
function buildProjectStats(
  sessions: StatSessionRow[],
  fileRows: { session_id: string; path: string; additions: number; deletions: number }[],
): ProjectStat[] {
  const filesBySession = new Map<string, { path: string; additions: number; deletions: number }[]>();
  for (const f of fileRows) {
    const arr = filesBySession.get(f.session_id);
    if (arr) arr.push(f);
    else filesBySession.set(f.session_id, [f]);
  }

  const projects = new Map<string, ProjectStat>();
  const ensure = (key: string): ProjectStat => {
    let p = projects.get(key);
    if (!p) {
      p = {
        project: key,
        sessions: 0,
        durationMs: 0,
        tokens: 0,
        cost: 0,
        costKnown: false,
        files: 0,
        additions: 0,
        deletions: 0,
        errors: 0,
        sessionRefs: [],
      };
      projects.set(key, p);
    }
    return p;
  };

  for (const s of sessions) {
    const files = filesBySession.get(s.id) ?? [];
    const tally = new Map<string, { files: number; add: number; del: number }>();
    for (const f of files) {
      const k = deriveProjectKey(f.path, s.project);
      const t = tally.get(k) ?? { files: 0, add: 0, del: 0 };
      t.files += 1;
      t.add += f.additions;
      t.del += f.deletions;
      tally.set(k, t);
    }

    let primary = '(no edits)';
    let best = -1;
    for (const [k, t] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (t.files > best) {
        best = t.files;
        primary = k;
      }
    }
    const p = ensure(primary);
    p.sessions += 1;
    p.durationMs += s.duration_ms ?? 0;
    p.tokens += s.token_usage ?? 0;
    if (s.cost_usd != null) {
      p.cost += s.cost_usd;
      p.costKnown = true;
    }
    p.errors += s.error_count ?? 0;
    for (const t of tally.values()) {
      p.files += t.files;
      p.additions += t.add;
      p.deletions += t.del;
    }
    const ref: ProjectSessionRef = {
      id: s.id,
      title: s.title,
      model: s.model,
      durationMs: s.duration_ms,
      tokens: s.token_usage,
      cost: s.cost_usd,
      errors: s.error_count,
    };
    p.sessionRefs.push(ref);
  }

  return [...projects.values()].sort(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions,
  );
}

export async function getStats(): Promise<StatsBundle> {
  const sessions = await queryRows<StatSessionRow>(
    'SELECT id, title, project, model, duration_ms, token_usage, cost_usd, error_count FROM sessions ORDER BY seq ASC',
  );
  const fileRows = await queryRows<{
    session_id: string;
    path: string;
    additions: number;
    deletions: number;
  }>('SELECT session_id, path, additions, deletions FROM changed_files');

  // per-project rollup (shared with getProjectStats — issue #8)
  const projectList = buildProjectStats(sessions, fileRows);

  const refById = new Map<string, ProjectSessionRef>();
  const projBySession = new Map<string, string>();
  for (const s of sessions) {
    refById.set(s.id, {
      id: s.id,
      title: s.title,
      model: s.model,
      durationMs: s.duration_ms,
      tokens: s.token_usage,
      cost: s.cost_usd,
      errors: s.error_count,
    });
    projBySession.set(s.id, s.project);
  }
  const fileMap = new Map<
    string,
    { path: string; project: string; add: number; del: number; sessionIds: Set<string> }
  >();
  for (const f of fileRows) {
    let fs = fileMap.get(f.path);
    if (!fs) {
      fs = {
        path: f.path,
        project: deriveProjectKey(f.path, projBySession.get(f.session_id) ?? 'LLMWiki'),
        add: 0,
        del: 0,
        sessionIds: new Set(),
      };
      fileMap.set(f.path, fs);
    }
    fs.add += f.additions;
    fs.del += f.deletions;
    fs.sessionIds.add(f.session_id);
  }
  const files: FileStat[] = [...fileMap.values()]
    .sort((a, b) => b.add + b.del - (a.add + a.del))
    .slice(0, 60)
    .map((fs) => ({
      path: fs.path,
      project: fs.project,
      sessions: fs.sessionIds.size,
      additions: fs.add,
      deletions: fs.del,
      sessionRefs: [...fs.sessionIds]
        .map((id) => refById.get(id))
        .filter((r): r is ProjectSessionRef => !!r),
    }));

  const skillRows = await queryRows<{ title: string; n: number }>(
    `SELECT title, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'skill'
      GROUP BY title
      ORDER BY n DESC
      LIMIT 40`,
  );
  const skills = skillRows.map((r) => ({
    name: r.title.replace(/^Skill\s*·\s*/, '').trim() || r.title,
    count: r.n,
  }));

  const saRows = await queryRows<{ subagent: string; n: number }>(
    `SELECT subagent, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'subagent'
        AND parent_id IS NULL
        AND subagent IS NOT NULL
      GROUP BY subagent
      ORDER BY n DESC
      LIMIT 40`,
  );
  const subagentTypes = saRows.map((r) => ({ name: r.subagent, count: r.n }));

  const memRows = await queryRows<{ file_path: string; n: number }>(
    `SELECT file_path, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'memory'
        AND file_path IS NOT NULL
      GROUP BY file_path
      ORDER BY n DESC
      LIMIT 40`,
  );
  const memory = memRows.map((r) => {
    const segs = r.file_path.split('/').filter(Boolean);
    return { name: segs.length <= 2 ? r.file_path : segs.slice(-2).join('/'), count: r.n };
  });

  const hookRows = await queryRows<{ ev: string | null; nm: string | null; n: number }>(
    `SELECT meta->>'hookEvent' ev,
            meta->>'hookName' nm,
            COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'hook'
      GROUP BY meta->>'hookEvent', meta->>'hookName'
      ORDER BY n DESC
      LIMIT 40`,
  );
  const hooks = hookRows.map((r) => ({
    name: r.ev ? (r.nm && r.nm !== r.ev ? `${r.ev} (${r.nm})` : r.ev) : r.nm ?? 'hook',
    count: r.n,
  }));

  const modelRows = await queryRows<{
    model: string;
    sessions: number;
    tokens: number;
    cost: number | null;
  }>(
    `SELECT COALESCE(model, '(unknown)') model,
            COUNT(*)::int sessions,
            COALESCE(SUM(token_usage), 0)::int tokens,
            SUM(cost_usd)::float8 cost
       FROM sessions
      GROUP BY model
      ORDER BY sessions DESC`,
  );
  const models = modelRows.map((r) => ({
    name: r.model,
    sessions: r.sessions,
    tokens: r.tokens ?? 0,
    cost: r.cost,
  }));

  const totals = sessions.reduce(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      durationMs: acc.durationMs + (s.duration_ms ?? 0),
      tokens: acc.tokens + (s.token_usage ?? 0),
      cost: acc.cost + (s.cost_usd ?? 0),
    }),
    { sessions: 0, durationMs: 0, tokens: 0, cost: 0 },
  );

  return { totals, projects: projectList, files, skills, subagentTypes, memory, hooks, models };
}

// Pending-findings count per session, for the Overview "要注意" panel. A finding
// is "pending" when it has no latest verdict; it "touches" a session when any of
// its evidence resolves to that session (mirrors FindingsExplorer.evidenceSessionId:
// evidence.session_id, OR a subject_id when subject_kind='session', OR a locator
// session key). Two batched queries (findings + their evidence) — no N+1.
export async function getPendingFindingsBySession(): Promise<Record<string, number>> {
  const findingRows = await queryRows<{ id: number }>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id) finding_id
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.id
       FROM findings f
       LEFT JOIN latest_verdict v ON v.finding_id = f.id
      WHERE v.finding_id IS NULL`,
  );
  if (findingRows.length === 0) return {};
  const pendingIds = findingRows.map((r) => r.id);

  const evidenceRows = await queryRows<FindingEvidenceRow>(
    `SELECT id, finding_id, subject_kind, session_id, locator, subject_id, note
       FROM finding_evidence
      WHERE finding_id = ANY($1::int[])`,
    [pendingIds],
  );

  // resolve each evidence row to a session id, exactly as the client does, then
  // count DISTINCT pending findings per session (so a finding with two pieces of
  // evidence in the same session counts once).
  const findingsBySession = new Map<string, Set<number>>();
  for (const row of evidenceRows) {
    const locator = parseLocator(row.locator);
    const locatorSession = ['session_id', 'sessionId', 'session']
      .map((k) => locator[k])
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const sessionId =
      row.session_id ??
      (row.subject_kind === 'session' ? row.subject_id : null) ??
      locatorSession ??
      null;
    if (!sessionId) continue;
    let set = findingsBySession.get(sessionId);
    if (!set) {
      set = new Set();
      findingsBySession.set(sessionId, set);
    }
    set.add(row.finding_id);
  }

  const out: Record<string, number> = {};
  for (const [sessionId, set] of findingsBySession) out[sessionId] = set.size;
  return out;
}

export async function getSessionEventCounts(): Promise<Record<string, Record<string, number>>> {
  const rows = await queryRows<{ session_id: string; type: string; n: number }>(
    `SELECT session_id, type, COUNT(*)::int n
       FROM transcript_events
      WHERE parent_id IS NULL
      GROUP BY session_id, type`,
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.session_id] ??= {})[r.type] = r.n;
  return out;
}
