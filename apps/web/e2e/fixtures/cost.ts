// e2e/fixtures/cost.ts — the G9 cost-anomaly fallback fixture (three sessions
// straddling the absolute floor) plus the cost-anomaly oracle query. Extracted
// verbatim from e2e/helpers.ts (file-size gate, I4). helpers.ts re-exports these
// symbols — including COST_ANOMALY_BASELINE — so existing import sites stay unbroken.
import { COST_ANOMALY_BASELINE } from "@lathe/shared";
export { COST_ANOMALY_BASELINE };
import { withDb } from "./db";

export type CostAnomalyExpectation = {
  session_id: string;
  parent_session_id: string | null;
  runner: string;
  cost_usd: number | null;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  cost_anomaly_threshold_usd: number;
  cost_anomaly: boolean;
};

export const COST_FIXTURE_IDS = [
  "e2e-cost-fallback-low",
  "e2e-cost-fallback-high",
  "e2e-cost-fallback-null",
] as const;
export const COST_FIXTURE_PROJECT_ID = "fixture:g9-cost-anomaly";

export async function seedCostFallbackFixtures() {
  const { absoluteFloorUsd } = COST_ANOMALY_BASELINE;
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint)
       VALUES ($1,'G9 Cost Anomaly Fixture',NULL,NULL)
       ON CONFLICT (id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              updated_at = CURRENT_TIMESTAMP`,
      [COST_FIXTURE_PROJECT_ID]
    );
    const rows = [
      {
        id: COST_FIXTURE_IDS[0],
        title: "E2E fallback cost low",
        cost: absoluteFloorUsd - 1,
        seq: 2,
      },
      {
        id: COST_FIXTURE_IDS[1],
        title: "E2E fallback cost high",
        cost: absoluteFloorUsd + 1,
        seq: 3,
      },
      {
        id: COST_FIXTURE_IDS[2],
        title: "E2E fallback cost null",
        cost: null,
        seq: 4,
      },
    ];
    for (const r of rows) {
      await client.query(
        `INSERT INTO sessions (
           id, project_id, project, title, runner, model, status, started_at, ended_at, duration_ms,
           turn_count, tool_count, edit_count, bash_count, subagent_count, error_count,
           token_usage, token_in, token_out, git_branch, commit_count, cost_usd, summary, seq
         ) VALUES (
           $1, $2, 'LLMWiki', $3, 'cursor', 'e2e-cost-baseline', 'done',
           '2026-06-11 00:00:00', '2026-06-11 00:00:01', 1000,
           1, 0, 0, 0, 0, 0,
           0, 0, 0, 'loop/12-g9-cost-anomaly', 0, $4, NULL, $5
         )`,
        [r.id, COST_FIXTURE_PROJECT_ID, r.title, r.cost, r.seq]
      );
    }
  });
}

export async function cleanupCostFallbackFixtures() {
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    await client.query("DELETE FROM projects WHERE id = $1", [COST_FIXTURE_PROJECT_ID]);
  });
}

export async function getCostAnomalyExpectations(
  sessionIds?: readonly string[]
): Promise<CostAnomalyExpectation[]> {
  const { minimumGroupSize, absoluteFloorUsd, medianMultiplier } = COST_ANOMALY_BASELINE;
  return withDb(async (client) => {
    const params: unknown[] = [minimumGroupSize, absoluteFloorUsd, medianMultiplier];
    const where = sessionIds?.length ? "WHERE session_id = ANY($4::text[])" : "";
    if (sessionIds?.length) params.push(sessionIds);
    const rows = await client.query<CostAnomalyExpectation>(
      `WITH cost_baseline AS (
         SELECT runner,
                COUNT(cost_usd)::int AS cost_anomaly_group_size,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS cost_anomaly_group_median_usd
           FROM sessions
          WHERE cost_usd IS NOT NULL
          GROUP BY runner
       ),
       scored AS (
         SELECT s.id AS session_id,
                s.parent_session_id,
                s.runner,
                s.cost_usd,
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
       SELECT scored.*,
              (
                cost_usd IS NOT NULL
                AND cost_usd > cost_anomaly_threshold_usd
              ) AS cost_anomaly
         FROM scored
         ${where}
        ORDER BY session_id ASC`,
      params
    );
    return rows.rows;
  });
}
