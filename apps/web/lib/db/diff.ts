import type { Attribution, AttributionMethod, ChangedFile, Confidence, DiffHunk, LinkedEvent } from '../types';
import { queryRows } from '../db.query';
import {
  type AttributionRow,
  type ChangedFileRow,
  type DiffHunkRow,
  type LinkedEventRow,
  toAttribution,
  toChangedFile,
  toEvent,
  toHunk,
} from './rows';

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
