import type {
  Attribution,
  AttributionMethod,
  Confidence,
  DiffHunk,
  EventFile,
  LinkedEvent,
  SessionBundle,
} from '../types';
import { queryRows } from '../db.query';
import { getSession } from './sessions';
import { countEventsByType, getAnnotations, getEvents } from './transcript-events';
import { getChangedFiles } from './diff';
import { getPullRequestsForSession } from './pr';
import {
  type AttributionRow,
  type DiffHunkRow,
  type EventFileRow,
  type LinkedEventRow,
  toAttribution,
  toEvent,
  toEventFile,
  toHunk,
} from './rows';

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
