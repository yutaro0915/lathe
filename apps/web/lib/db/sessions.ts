import type { Session } from '../types';
import { COST_ANOMALY_BASELINE } from '@lathe/shared';
import { queryOne, queryRows } from '../db.query';
import { type SessionRow, toSession } from './rows';

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
       AND session_class = 'development'
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
