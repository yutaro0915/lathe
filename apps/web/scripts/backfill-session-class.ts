/**
 * Backfill session_class for all existing sessions.
 *
 * The incremental ingest skips unchanged sessions (mtime guard), so newly
 * added `classifySession` logic never runs on pre-existing rows. This script
 * reads the classification signals already stored in the DB — model,
 * project_id, projects.cwd_hint, title — and re-derives the correct
 * session_class without touching transcripts or wiping any data.
 *
 * Usage:
 *   pnpm -C apps/web run backfill:session-class
 *   DATABASE_URL=postgres://... pnpm -C apps/web run backfill:session-class
 *
 * Safety:
 *   - Only UPDATEs session_class. No DELETE / DROP / resetDatabase.
 *   - Fully idempotent: re-running re-derives the class from current signals.
 *   - Runs in a single transaction per batch of 500 rows.
 *
 * ADR 0012: session_class second axis.
 */

import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { classifySession } from './ingest/domain/session-class';
import type { SessionClassInput } from './ingest/domain/session-class';

const PREFIX = '[backfill-session-class]';
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Row → ClassifyInput mapping (pure function — the core of this script)
// ---------------------------------------------------------------------------

/** DB row returned by the SELECT query. */
export interface SessionRow {
  id: string;
  model: string | null;
  project_id: string;
  project_cwd_hint: string | null;
  title: string;
}

/**
 * Map a DB row to a `classifySession` input.
 *
 * This function is the single source of truth for "which DB columns feed the
 * classifier". Extracting it makes it trivially testable without a DB.
 */
export function rowToClassifyInput(row: SessionRow): SessionClassInput {
  return {
    model: row.model,
    projectId: row.project_id,
    projectCwdHint: row.project_cwd_hint,
    title: row.title,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  console.log(
    `${PREFIX} connecting (db: ${url.replace(/:[^@]*@/, ':***@')})`,
  );

  const pool = new Pool({ connectionString: url });

  try {
    // 1. Fetch all sessions with the columns classifySession needs.
    //    JOIN projects to get cwd_hint — this is the only JOIN needed.
    const { rows } = await pool.query<SessionRow>(`
      SELECT
        s.id,
        s.model,
        s.project_id,
        p.cwd_hint AS project_cwd_hint,
        s.title
      FROM sessions s
      JOIN projects p ON p.id = s.project_id
      ORDER BY s.id
    `);

    console.log(`${PREFIX} fetched ${rows.length} session(s) to classify`);

    if (rows.length === 0) {
      console.log(`${PREFIX} nothing to backfill`);
      return;
    }

    // 2. Classify each row and collect (id, session_class) pairs.
    const updates: Array<{ id: string; session_class: string }> = rows.map((row) => ({
      id: row.id,
      session_class: classifySession(rowToClassifyInput(row)),
    }));

    // 3. UPDATE in batches inside a transaction to keep the operation atomic
    //    per batch and avoid a single huge transaction on large datasets.
    let updated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { id, session_class } of batch) {
          await client.query(
            'UPDATE sessions SET session_class = $1 WHERE id = $2',
            [session_class, id],
          );
        }
        await client.query('COMMIT');
        updated += batch.length;
        console.log(`${PREFIX} updated ${updated}/${updates.length}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // 4. Log class distribution.
    const { rows: dist } = await pool.query<{ session_class: string; count: string }>(`
      SELECT session_class, count(*)::text AS count
      FROM sessions
      GROUP BY session_class
      ORDER BY count DESC
    `);

    console.log(`${PREFIX} class distribution after backfill:`);
    for (const { session_class, count } of dist) {
      console.log(`  ${session_class}: ${count}`);
    }

    console.log(`${PREFIX} done — ${updated} session(s) updated`);
  } finally {
    await pool.end().catch(() => {
      /* ignore teardown errors */
    });
  }
}

main().catch((err) => {
  console.error(`${PREFIX} failed: ${(err as Error).message}`);
  process.exit(1);
});
