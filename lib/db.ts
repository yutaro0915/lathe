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
  StatsBundle,
  ProjectStat,
  ProjectSessionRef,
  FileStat,
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
      'SELECT type, COUNT(*) AS n FROM transcript_events WHERE session_id = ? AND parent_id IS NULL GROUP BY type'
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

// ---- cross-session stats (the /stats page) --------------------------------

// Derive a "project directory" key from an absolute changed-file path, relative
// to the session's repo basename. projects/<slug> stays a unit; other hub dirs
// (wiki, memory, raw, …) collapse to their top segment; repo-root files and
// out-of-repo paths get their own buckets. Keeps the tool repo-agnostic (uses
// the session's own project name as the marker, not a hard-coded path).
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

export function getStats(): StatsBundle {
  const db = getDb();
  const sessions = db
    .prepare(
      'SELECT id, title, project, model, duration_ms, token_usage, cost_usd, error_count FROM sessions ORDER BY seq ASC'
    )
    .all() as unknown as StatSessionRow[];
  const fileRows = db
    .prepare('SELECT session_id, path, additions, deletions FROM changed_files')
    .all() as unknown as {
    session_id: string;
    path: string;
    additions: number;
    deletions: number;
  }[];

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
    // tally changed files per derived project key for THIS session
    const tally = new Map<string, { files: number; add: number; del: number }>();
    for (const f of files) {
      const k = deriveProjectKey(f.path, s.project);
      const t = tally.get(k) ?? { files: 0, add: 0, del: 0 };
      t.files += 1;
      t.add += f.additions;
      t.del += f.deletions;
      tally.set(k, t);
    }
    // primary project = where the session changed the most files (ties: alpha)
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
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions
  );

  // ---- per-file rollup: which file, in which project, and the sessions that
  // touched it (so file-level activity is traceable back to where it happened).
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

  // ---- light "usage" observation (Phase 1 = counts only, no evaluation) ----
  const skillRows = db
    .prepare(
      "SELECT title, COUNT(*) n FROM transcript_events WHERE type='skill' GROUP BY title ORDER BY n DESC LIMIT 40"
    )
    .all() as unknown as { title: string; n: number }[];
  const skills = skillRows.map((r) => ({
    name: r.title.replace(/^Skill\s*·\s*/, '').trim() || r.title,
    count: r.n,
  }));

  const saRows = db
    .prepare(
      "SELECT subagent, COUNT(*) n FROM transcript_events WHERE type='subagent' AND parent_id IS NULL AND subagent IS NOT NULL GROUP BY subagent ORDER BY n DESC LIMIT 40"
    )
    .all() as unknown as { subagent: string; n: number }[];
  const subagentTypes = saRows.map((r) => ({ name: r.subagent, count: r.n }));

  const modelRows = db
    .prepare(
      'SELECT COALESCE(model, \'(unknown)\') model, COUNT(*) sessions, SUM(token_usage) tokens, SUM(COALESCE(cost_usd,0)) cost FROM sessions GROUP BY model ORDER BY sessions DESC'
    )
    .all() as unknown as { model: string; sessions: number; tokens: number; cost: number }[];
  const models = modelRows.map((r) => ({
    name: r.model,
    sessions: r.sessions,
    tokens: r.tokens ?? 0,
    cost: r.cost ?? 0,
  }));

  const totals = sessions.reduce(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      durationMs: acc.durationMs + (s.duration_ms ?? 0),
      tokens: acc.tokens + (s.token_usage ?? 0),
      cost: acc.cost + (s.cost_usd ?? 0),
    }),
    { sessions: 0, durationMs: 0, tokens: 0, cost: 0 }
  );

  return { totals, projects: projectList, files, skills, subagentTypes, models };
}
