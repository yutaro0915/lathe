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
} from './types';
import { queryOne, queryRows } from './postgres';

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
  summary: string | null;
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
    summary: r.summary,
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

export async function getPrimarySession(): Promise<Session> {
  const row = await queryOne<SessionRow>('SELECT * FROM sessions WHERE seq = 1 LIMIT 1');
  if (row) return toSession(row);

  const first = await queryOne<SessionRow>('SELECT * FROM sessions ORDER BY seq ASC LIMIT 1');
  if (!first) {
    throw new Error('No sessions found. Run `pnpm ingest` first.');
  }
  return toSession(first);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const row = await queryOne<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
  return row ? toSession(row) : undefined;
}

export async function listSessions(): Promise<Session[]> {
  const rows = await queryRows<SessionRow>('SELECT * FROM sessions ORDER BY seq ASC');
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
  const rows = await queryRows<SessionRow & { link_method: string }>(
    `SELECT s.*, spr.source AS link_method
       FROM session_pull_requests spr
       JOIN sessions s ON s.id = spr.session_id
      WHERE spr.pr_id = $1
      ORDER BY spr.pr_updated_at DESC, s.seq ASC`,
    [prId],
  );
  return rows.map((row) => ({ session: toSession(row), linkMethod: row.link_method as 'sha' | 'branch' }));
}

export async function getPullRequestBundle(id: string): Promise<PullRequestBundle | undefined> {
  const pullRequest = await getPullRequest(id);
  if (!pullRequest) return undefined;
  return {
    pullRequest,
    linkedSessions: await getSessionsForPullRequest(id),
  };
}

// ---- transcript event queries ---------------------------------------------

export async function getEvents(sessionId: string): Promise<TranscriptEvent[]> {
  const rows = await queryRows<TranscriptEventRow>(
    'SELECT * FROM transcript_events WHERE session_id = $1 ORDER BY seq ASC, parent_id NULLS FIRST, id ASC',
    [sessionId],
  );
  return rows.map(toEvent);
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

  const eventFilePairs = await Promise.all(events.map(async (e) => [e.id, await getEventFiles(e.id)] as const));
  const eventFiles: Record<string, EventFile[]> = {};
  for (const [eventId, files] of eventFilePairs) {
    if (files.length) eventFiles[eventId] = files;
  }

  const hunks: Record<string, DiffHunk[]> = {};
  const attributions: Record<string, Attribution[]> = {};
  const linkedEvents: Record<string, LinkedEvent[]> = {};
  for (const f of changedFiles) {
    const fh = await getHunks(f.id);
    hunks[f.id] = fh;
    const attrPairs = await Promise.all(
      fh.map(async (h) => [h.id, await getAttributionsForHunk(h.id)] as const),
    );
    for (const [hunkId, attrs] of attrPairs) attributions[hunkId] = attrs;
    linkedEvents[f.id] = await getLinkedEventsForFile(f.id);
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

  const projectList = [...projects.values()].sort(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions,
  );

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
