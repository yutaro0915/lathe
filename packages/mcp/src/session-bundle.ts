// Heavy session bundle concern: getMcpSessionBundle and its supporting types/helpers.
// Depends on sessions.ts (for getSession) and ./postgres only.

import { queryRows } from './postgres';
import { getSession } from './sessions';

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

interface LinkedEventRow extends TranscriptEventRow {
  __confidence: string;
  __method: string;
  __hunk_id: string;
  __file_id: string;
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
