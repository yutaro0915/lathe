import { COST_ANOMALY_BASELINE } from '@lathe/shared';
import { queryRows } from '../../lib/postgres';
import type { EventRow, HunkSignalRow, RunAnalystOptions, SessionRow } from './common';

export function sessionFilter(options: RunAnalystOptions): { sql: string; params: unknown[] } {
  if (options.turn) return { sql: 's.id = $1', params: [options.turn.sessionId] };
  if (options.sessionId) return { sql: 's.id = $1', params: [options.sessionId] };
  const ids = options.sessionIds?.filter(Boolean);
  if (ids?.length) return { sql: 's.id = ANY($1::text[])', params: [ids] };
  return { sql: 'TRUE', params: [] };
}

export async function listTargetSessions(options: RunAnalystOptions): Promise<SessionRow[]> {
  const filter = sessionFilter(options);
  const params = [
    COST_ANOMALY_BASELINE.minimumGroupSize,
    COST_ANOMALY_BASELINE.absoluteFloorUsd,
    COST_ANOMALY_BASELINE.medianMultiplier,
    ...filter.params,
  ];
  const where = shiftedWhere(filter.sql, 3, filter.params.length);
  return queryRows<SessionRow>(
    `WITH cost_baseline AS (
       SELECT runner,
              COUNT(cost_usd)::int AS cost_group_size,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS cost_group_median_usd
         FROM sessions
        WHERE cost_usd IS NOT NULL
        GROUP BY runner
     ),
     scored AS (
       SELECT s.*,
              COALESCE(b.cost_group_size, 0)::int AS cost_group_size,
              b.cost_group_median_usd,
              CASE
                WHEN s.cost_usd IS NULL THEN $2::float8
                WHEN COALESCE(b.cost_group_size, 0) < $1::int THEN $2::float8
                WHEN b.cost_group_median_usd IS NULL THEN $2::float8
                ELSE GREATEST(b.cost_group_median_usd * $3::float8, $2::float8)
              END AS cost_threshold_usd
         FROM sessions s
         LEFT JOIN cost_baseline b ON b.runner = s.runner
     )
     SELECT *,
            (cost_usd IS NOT NULL AND cost_usd > cost_threshold_usd) AS cost_anomaly
       FROM scored s
      WHERE ${where}
      ORDER BY
            CASE WHEN (cost_usd IS NOT NULL AND cost_usd > cost_threshold_usd) THEN 0 ELSE 1 END,
            error_count DESC,
            cost_usd DESC NULLS LAST,
            seq ASC`,
    params,
  );
}

export async function listEventsForSessions(sessionIds: string[], options: RunAnalystOptions): Promise<EventRow[]> {
  if (!sessionIds.length) return [];
  if (options.turn) {
    return queryRows<EventRow>(
      `SELECT id,session_id,seq,type,title,body,command,exit_code
         FROM transcript_events
        WHERE session_id = $1
          AND seq BETWEEN $2 AND $3
        ORDER BY seq ASC, id ASC`,
      [options.turn.sessionId, Math.max(1, options.turn.seq - 3), options.turn.seq + 3],
    );
  }
  return queryRows<EventRow>(
    `SELECT id,session_id,seq,type,title,body,command,exit_code
       FROM transcript_events
      WHERE session_id = ANY($1::text[])
      ORDER BY session_id ASC, seq ASC, id ASC`,
    [sessionIds],
  );
}

export async function listUnattributedDiffSignals(options: RunAnalystOptions): Promise<HunkSignalRow[]> {
  const filter = sessionFilter(options);
  const where = unattributedWhere(options, filter.sql);
  const params = options.turn ? [options.turn.sessionId, options.turn.seq] : filter.params;
  return queryRows<HunkSignalRow>(
    `SELECT cf.session_id,
            s.project_id,
            s.harness_version_id,
            COUNT(*)::int AS hunks,
            SUM(CASE WHEN a.event_id IS NULL OR a.confidence = 'unattributed' THEN 1 ELSE 0 END)::int AS unattributed,
            MIN(h.id) FILTER (WHERE a.event_id IS NULL OR a.confidence = 'unattributed') AS first_hunk_id,
            MIN(cf.path) FILTER (WHERE a.event_id IS NULL OR a.confidence = 'unattributed') AS first_path
       FROM changed_files cf
       JOIN sessions s ON s.id = cf.session_id
       JOIN diff_hunks h ON h.file_id = cf.id
       LEFT JOIN attributions a ON a.hunk_id = h.id
      WHERE ${where}
      GROUP BY cf.session_id,s.project_id,s.harness_version_id
     HAVING COUNT(*) >= 3
        AND SUM(CASE WHEN a.event_id IS NULL OR a.confidence = 'unattributed' THEN 1 ELSE 0 END)::float8 / COUNT(*) >= 0.25
      ORDER BY unattributed DESC, hunks DESC
      LIMIT 20`,
    params,
  );
}

function shiftedWhere(sql: string, offset: number, paramCount: number): string {
  let where = sql;
  for (let i = paramCount; i >= 1; i--) {
    where = where.replaceAll(`$${i}`, `$${i + offset}`);
  }
  return where;
}

function unattributedWhere(options: RunAnalystOptions, filterSql: string): string {
  if (options.turn) {
    return `cf.session_id = $1 AND EXISTS (
      SELECT 1
        FROM attributions a
        JOIN transcript_events e ON e.id = a.event_id
       WHERE a.hunk_id = h.id
         AND e.session_id = $1
         AND e.seq = $2
    )`;
  }
  if (options.sessionId || options.sessionIds?.length) return filterSql.replaceAll('s.', '').replaceAll('id', 'cf.session_id');
  return 'TRUE';
}
