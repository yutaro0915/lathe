// lib/db.ts — Phase 1 read-only data access over SQLite (node:sqlite).
//
// Opens data/lathe.db once (lazy singleton). Every query returns plain row
// objects with snake_case keys; we cast to a Row shape and map to the camelCase
// records declared in lib/types.ts. node:sqlite prints an ExperimentalWarning at
// runtime — that is harmless, not an error.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
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
} from './types';

// ---- raw row shapes (snake_case, as returned by node:sqlite) --------------

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

// LinkedEvent join row: a transcript event plus the attribution metadata.
interface LinkedEventRow extends TranscriptEventRow {
  __confidence: string;
  __method: string;
  __hunk_id: string;
}

// ---- row -> record mappers -------------------------------------------------

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

// ---- lazy singleton --------------------------------------------------------

let _db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dbPath = path.join(process.cwd(), 'data', 'lathe.db');
    _db = new DatabaseSync(dbPath);
  }
  return _db;
}

// ---- session queries -------------------------------------------------------

export function getPrimarySession(): Session {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM sessions WHERE seq = 1 LIMIT 1')
    .get() as unknown as SessionRow | undefined;
  if (!row) {
    // Fall back to the lowest-seq session so the viewer always has something.
    const first = db
      .prepare('SELECT * FROM sessions ORDER BY seq ASC LIMIT 1')
      .get() as unknown as SessionRow | undefined;
    if (!first) {
      throw new Error('No sessions found. Run `pnpm seed` to populate data/lathe.db.');
    }
    return toSession(first);
  }
  return toSession(row);
}

export function getSession(id: string): Session | undefined {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as unknown as SessionRow | undefined;
  return row ? toSession(row) : undefined;
}

export function listSessions(): Session[] {
  const rows = getDb()
    .prepare('SELECT * FROM sessions ORDER BY seq ASC')
    .all() as unknown as SessionRow[];
  return rows.map(toSession);
}

// ---- transcript event queries ---------------------------------------------

export function getEvents(sessionId: string): TranscriptEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as unknown as TranscriptEventRow[];
  return rows.map(toEvent);
}

export function getEvent(id: string): TranscriptEvent | undefined {
  const row = getDb()
    .prepare('SELECT * FROM transcript_events WHERE id = ?')
    .get(id) as unknown as TranscriptEventRow | undefined;
  return row ? toEvent(row) : undefined;
}

export function getEventFiles(eventId: string): EventFile[] {
  const rows = getDb()
    .prepare('SELECT * FROM event_files WHERE event_id = ? ORDER BY id ASC')
    .all(eventId) as unknown as EventFileRow[];
  return rows.map(toEventFile);
}

export function getAnnotations(sessionId: string): Annotation[] {
  const rows = getDb()
    .prepare('SELECT * FROM annotations WHERE session_id = ? ORDER BY at_seq ASC')
    .all(sessionId) as unknown as AnnotationRow[];
  return rows.map(toAnnotation);
}

// ---- git diff queries ------------------------------------------------------

export function getChangedFiles(sessionId: string): ChangedFile[] {
  const rows = getDb()
    .prepare('SELECT * FROM changed_files WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as unknown as ChangedFileRow[];
  return rows.map(toChangedFile);
}

export function getHunks(fileId: string): DiffHunk[] {
  const rows = getDb()
    .prepare('SELECT * FROM diff_hunks WHERE file_id = ? ORDER BY seq ASC')
    .all(fileId) as unknown as DiffHunkRow[];
  return rows.map(toHunk);
}

export function getAttributionsForHunk(hunkId: string): Attribution[] {
  const rows = getDb()
    .prepare('SELECT * FROM attributions WHERE hunk_id = ? ORDER BY id ASC')
    .all(hunkId) as unknown as AttributionRow[];
  return rows.map(toAttribution);
}

// ---- attribution join (screen B "Linked Events") --------------------------

// Join hunks -> attributions -> events for a file. Returns one entry per
// (event, hunk) pair carrying the attribution's confidence + method + hunkId.
// Unattributed rows (event_id IS NULL, e.g. a dirty-worktree hunk) carry no
// transcript event, so they are skipped here — the aside surfaces them via the
// per-hunk attribution + banner instead. Kept deliberately simple.
export function getLinkedEventsForFile(fileId: string): LinkedEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT e.*,
              a.confidence AS __confidence,
              a.method     AS __method,
              a.hunk_id    AS __hunk_id
         FROM attributions a
         JOIN diff_hunks   h ON h.id = a.hunk_id
         JOIN transcript_events e ON e.id = a.event_id
        WHERE h.file_id = ?
          AND a.event_id IS NOT NULL
        ORDER BY h.seq ASC, e.seq ASC`
    )
    .all(fileId) as unknown as LinkedEventRow[];

  return rows.map((r) => ({
    event: toEvent(r),
    confidence: r.__confidence as Confidence,
    method: r.__method as AttributionMethod,
    hunkId: r.__hunk_id,
  }));
}

// ---- aggregates ------------------------------------------------------------

export function countEventsByType(sessionId: string): Record<string, number> {
  const rows = getDb()
    .prepare(
      'SELECT type, COUNT(*) AS n FROM transcript_events WHERE session_id = ? GROUP BY type'
    )
    .all(sessionId) as unknown as { type: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = r.n;
  return out;
}

// ---- full per-session bundle (for the interactive client) ------------------

// Assemble EVERYTHING one session needs on the client in a single serializable
// object. Called by the server pages; the client never touches the db.
export function getSessionBundle(id: string): SessionBundle | undefined {
  const session = getSession(id);
  if (!session) return undefined;

  const events = getEvents(id);
  const typeCounts = countEventsByType(id);
  const annotations = getAnnotations(id);
  const changedFiles = getChangedFiles(id);

  const eventFiles: Record<string, EventFile[]> = {};
  for (const e of events) {
    const ef = getEventFiles(e.id);
    if (ef.length) eventFiles[e.id] = ef;
  }

  const hunks: Record<string, DiffHunk[]> = {};
  const attributions: Record<string, Attribution[]> = {};
  const linkedEvents: Record<string, LinkedEvent[]> = {};
  for (const f of changedFiles) {
    const fh = getHunks(f.id);
    hunks[f.id] = fh;
    for (const h of fh) attributions[h.id] = getAttributionsForHunk(h.id);
    linkedEvents[f.id] = getLinkedEventsForFile(f.id);
  }

  return {
    session,
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
