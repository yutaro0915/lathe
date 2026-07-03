import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool } from 'pg';

import { runIncrementalIngest } from '../ingest/usecase/incremental';

type VerdictFn = (label: string, pass: boolean, detail: string) => void;

function makeRunManifestRepo(tmpDir: string, name: string): string {
  const repoRoot = path.join(tmpDir, name);
  fs.mkdirSync(path.join(repoRoot, '.lathe', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: /tmp/nonexistent\n', 'utf8');
  return repoRoot;
}

function writeRunManifest(repoRoot: string, fileName: string, manifest: unknown): void {
  const manifestPath = path.join(repoRoot, '.lathe', 'runs', fileName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

async function ingestRunRepo(pool: Pool, repoRoot: string): Promise<void> {
  await runIncrementalIngest(pool, {
    dirs: [],
    codexRolloutFiles: [],
    runManifestRepoRoot: repoRoot,
  });
}

export async function verifyRunManifestInvariants({
  pool,
  tmpDir,
  verdict,
}: {
  pool: Pool;
  tmpDir: string;
  verdict: VerdictFn;
}): Promise<void> {
  const runRepoA = makeRunManifestRepo(tmpDir, 'run-project-a');
  const runRepoB = makeRunManifestRepo(tmpDir, 'run-project-b');
  writeRunManifest(runRepoA, 'issue-23.json', {
    issue: 23,
    stages: [
      {
        stage: 'PLAN',
        session_id: null,
        verdict: 'PLAN_READY',
        backend: null,
        ts: '2026-07-03T00:00:00.000Z',
        skipped: true,
        cost_usd: 0.12,
        backend_token_usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stage: 'IMPLEMENT',
        session_id: 'missing-session-ok',
        verdict: 'ESCALATE',
        backend: 'codex',
        backend_model: 'gpt-test',
        head_sha: 'abc123',
        duration_ms: 321,
        ts: '2026-07-03T00:01:00.000Z',
        backend_cost_usd: 0.34,
        backend_cost_source: 'codex.jsonl.explicit_cost',
      },
    ],
  });
  writeRunManifest(runRepoA, 'issue-23.attempt1.json', {
    issue: 23,
    stages: [{ stage: 'REVIEW', session_id: 'review-attempt', verdict: null }],
  });
  writeRunManifest(runRepoA, 'plan-43.json', {
    issue: 43,
    stages: [{ stage: 'PLAN', session_id: 'plan-session', verdict: null, backend: null }],
  });
  fs.writeFileSync(
    path.join(runRepoA, '.lathe', 'runs', 'issue-23.escalation.md'),
    '# escalation\n',
    'utf8',
  );
  writeRunManifest(runRepoB, 'issue-23.json', {
    issue: 23,
    stages: [{ stage: 'PLAN', session_id: 'project-b-plan', verdict: null }],
  });

  await ingestRunRepo(pool, runRepoA);
  await ingestRunRepo(pool, runRepoB);

  const projectRows = await pool.query<{ id: string; cwd_hint: string }>(
    `SELECT id, cwd_hint FROM projects WHERE cwd_hint IN ($1, $2)`,
    [runRepoA, runRepoB],
  );
  const projectAId = projectRows.rows.find((row) => row.cwd_hint === runRepoA)?.id ?? '';
  const projectBId = projectRows.rows.find((row) => row.cwd_hint === runRepoB)?.id ?? '';

  const sameKeyRows = await pool.query<{ project_id: string; run_key: string }>(
    `SELECT project_id, run_key FROM runs WHERE run_key = 'issue-23' ORDER BY project_id`,
  );
  verdict(
    'run manifest project scope',
    sameKeyRows.rows.length === 2 && new Set(sameKeyRows.rows.map((row) => row.project_id)).size === 2,
    JSON.stringify(sameKeyRows.rows),
  );

  const distinctRows = await pool.query<{ run_key: string }>(
    `SELECT run_key FROM runs WHERE project_id = $1 ORDER BY run_key`,
    [projectAId],
  );
  verdict(
    'run manifest key variants',
    JSON.stringify(distinctRows.rows.map((row) => row.run_key))
      === JSON.stringify(['issue-23', 'issue-23.attempt1', 'plan-43']),
    JSON.stringify(distinctRows.rows),
  );

  const projectionRows = await pool.query<{
    stage_index: number;
    session_id: string | null;
    verdict: string | null;
    backend: string | null;
    backend_cost_usd: number | null;
    backend_cost_source: string | null;
    legacy_backend_cost_usd: number | null;
    has_escalation: boolean;
    escalation_path: string | null;
    backend_input_tokens: string | null;
  }>(
    `SELECT rs.stage_index, rs.session_id, rs.verdict, rs.backend,
            rs.backend_cost_usd, rs.backend_cost_source, rs.legacy_backend_cost_usd,
            r.has_escalation, r.escalation_path,
            rs.backend_token_usage->>'input_tokens' AS backend_input_tokens
       FROM runs r
       JOIN run_stages rs
         ON rs.project_id = r.project_id
        AND rs.run_key = r.run_key
      WHERE r.project_id = $1
        AND r.run_key = 'issue-23'
      ORDER BY rs.stage_index`,
    [projectAId],
  );
  const projectionOk =
    projectionRows.rows.length === 2
    && projectionRows.rows[0].stage_index === 0
    && projectionRows.rows[0].session_id === null
    && projectionRows.rows[0].backend === null
    && projectionRows.rows[0].legacy_backend_cost_usd === 0.12
    && projectionRows.rows[0].backend_cost_usd === null
    && projectionRows.rows[0].backend_input_tokens === '10'
    && projectionRows.rows[1].stage_index === 1
    && projectionRows.rows[1].session_id === 'missing-session-ok'
    && projectionRows.rows[1].verdict === 'ESCALATE'
    && projectionRows.rows[1].backend === 'codex'
    && projectionRows.rows[1].backend_cost_usd === 0.34
    && projectionRows.rows[1].backend_cost_source === 'codex.jsonl.explicit_cost'
    && projectionRows.rows.every((row) => row.has_escalation)
    && projectionRows.rows.every((row) => row.escalation_path === '.lathe/runs/issue-23.escalation.md');
  verdict('run manifest SQL projection', projectionOk, JSON.stringify(projectionRows.rows));

  const stageRowsSql = `
    SELECT run_key, stage_index, backend_cost_usd, legacy_backend_cost_usd
      FROM run_stages
     WHERE project_id = $1
     ORDER BY run_key, stage_index`;
  const before = await pool.query(stageRowsSql, [projectAId]);
  await ingestRunRepo(pool, runRepoA);
  const after = await pool.query(stageRowsSql, [projectAId]);
  verdict(
    'run manifest 冪等',
    JSON.stringify(before.rows) === JSON.stringify(after.rows),
    `before=${JSON.stringify(before.rows)}, after=${JSON.stringify(after.rows)}`,
  );

  fs.rmSync(path.join(runRepoA, '.lathe', 'runs', 'issue-23.attempt1.json'), { force: true });
  await ingestRunRepo(pool, runRepoA);
  const afterDelete = await pool.query<{ project_id: string; run_key: string }>(
    `SELECT project_id, run_key FROM runs
      WHERE run_key IN ('issue-23', 'issue-23.attempt1')
      ORDER BY project_id, run_key`,
  );
  const deleteOk =
    !afterDelete.rows.some((row) => row.project_id === projectAId && row.run_key === 'issue-23.attempt1')
    && afterDelete.rows.some((row) => row.project_id === projectAId && row.run_key === 'issue-23')
    && afterDelete.rows.some((row) => row.project_id === projectBId && row.run_key === 'issue-23');
  verdict('run manifest missing-file delete', deleteOk, JSON.stringify(afterDelete.rows));

  await pool.query(`DROP TABLE run_stages, runs`);
  await ingestRunRepo(pool, runRepoA);
  const reconstructed = await pool.query<{ run_count: string; stage_count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM runs WHERE project_id = $1) AS run_count,
       (SELECT COUNT(*) FROM run_stages WHERE project_id = $1) AS stage_count`,
    [projectAId],
  );
  verdict(
    'run manifest drop/re-ingest',
    Number(reconstructed.rows[0].run_count) === 2 && Number(reconstructed.rows[0].stage_count) === 3,
    JSON.stringify(reconstructed.rows[0]),
  );
}
