import { Pool, type PoolClient } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { parseRepo, syncPullRequestsGraphql } from './ingest/github';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function counts(client: PoolClient, projectId: string): Promise<{ pullRequests: number; prCommits: number }> {
  const pullRequests = Number(
    (await client.query('SELECT COUNT(*) AS n FROM pull_requests WHERE project_id = $1', [projectId])).rows[0]?.n ?? 0,
  );
  const prCommits = Number(
    (
      await client.query(
        `SELECT COUNT(*) AS n
           FROM pr_commits pc
           JOIN pull_requests pr ON pr.id = pc.pr_id
          WHERE pr.project_id = $1`,
        [projectId],
      )
    ).rows[0]?.n ?? 0,
  );
  return { pullRequests, prCommits };
}

async function runSync(client: PoolClient, repo: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await syncPullRequestsGraphql(client, { repo });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const repoName = argValue('--repo');
  if (!repoName) throw new Error('usage: pnpm -F web verify:pr-idempotency -- --repo owner/name');
  const repo = parseRepo(repoName);
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  const client = await pool.connect();
  try {
    await runSync(client, repo.fullName);
    const first = await counts(client, repo.projectId);
    await runSync(client, repo.fullName);
    const second = await counts(client, repo.projectId);

    console.log('================ Lathe PR idempotency verification ================');
    console.log(`repo              : ${repo.fullName}`);
    console.log(`pull_requests run1: ${first.pullRequests}`);
    console.log(`pull_requests run2: ${second.pullRequests}`);
    console.log(`pr_commits run1   : ${first.prCommits}`);
    console.log(`pr_commits run2   : ${second.prCommits}`);
    console.log('===================================================================');

    if (first.pullRequests !== second.pullRequests) throw new Error('pull_requests count changed after second backfill');
    if (first.prCommits !== second.prCommits) throw new Error('pr_commits count changed after second backfill');
    console.log('VERDICT: GREEN — repeated backfill is idempotent.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[verify-pr-idempotency] failed: ${(error as Error).message}`);
  process.exit(1);
});
