import type { PoolClient } from 'pg';
import type { SpawnLink } from '../domain/subagent-link';

export async function applySubagentLinks(client: PoolClient, spawnLinks: SpawnLink[]): Promise<void> {
  if (!spawnLinks.length) return;

  const childIds = [...new Set(spawnLinks.map((link) => link.childSessionId))];
  const existingRows = await client.query<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ANY($1::text[])',
    [childIds],
  );
  const existingChildIds = new Set(existingRows.rows.map((row) => row.id));

  for (const link of spawnLinks) {
    if (!existingChildIds.has(link.childSessionId)) {
      await client.query(
        `UPDATE transcript_events
            SET meta = CASE WHEN meta IS NULL THEN NULL ELSE meta - 'child_session_id' END
          WHERE id = $1`,
        [link.eventId],
      );
      continue;
    }
    await client.query(
      `UPDATE sessions
          SET parent_session_id = $1,
              spawned_by_seq = $2
        WHERE id = $3`,
      [link.parentSessionId, link.spawnedBySeq, link.childSessionId],
    );
    await client.query(
      `UPDATE transcript_events
          SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('child_session_id', $1::text)
        WHERE id = $2`,
      [link.childSessionId, link.eventId],
    );
  }
}

// Incremental re-ingest of a single session (replaceBuiltSession) only carries
// that session's own events. When the re-ingested session is a sub-agent CHILD,
// its spawn_agent launcher lives in the PARENT session, so linkSubagentSessions
// (which walks the built session's events) cannot restore parent_session_id.
// Reverse-lookup the real parent from a spawn_agent event in another session
// that names this child as its agent_id, and re-establish the link.
//
// Anti-fabrication: link only when a real launcher exists in the DB. The query
// requires the launcher event (and therefore the parent session) to exist, and
// we never create a parent — absent launcher leaves parent_session_id NULL.
export async function restoreSubagentParentLink(client: PoolClient, childSessionId: string): Promise<void> {
  const launcher = await client.query<{ parentSessionId: string; spawnedBySeq: number; eventId: string }>(
    `SELECT session_id AS "parentSessionId", seq AS "spawnedBySeq", id AS "eventId"
       FROM transcript_events
      WHERE type = 'subagent'
        AND parent_id IS NULL
        AND meta->>'agent_id' = $1
        AND session_id <> $1
      ORDER BY session_id ASC, seq ASC
      LIMIT 1`,
    [childSessionId],
  );
  const row = launcher.rows[0];
  if (!row) return;
  await client.query(
    `UPDATE sessions
        SET parent_session_id = $1,
            spawned_by_seq = $2
      WHERE id = $3`,
    [row.parentSessionId, row.spawnedBySeq, childSessionId],
  );
  await client.query(
    `UPDATE transcript_events
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('child_session_id', $1::text)
      WHERE id = $2`,
    [childSessionId, row.eventId],
  );
}
