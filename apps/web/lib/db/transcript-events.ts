import type { Annotation, EventFile, TranscriptEvent } from '../types';
import { queryOne, queryRows } from '../db.query';
import {
  type AnnotationRow,
  type EventFileRow,
  type TranscriptEventRow,
  toAnnotation,
  toEvent,
  toEventFile,
} from './rows';

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
