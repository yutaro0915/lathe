import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { parseRepo, syncPullRequestsGraphql } from './ingest/github';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ghPrCount(repo: string): number {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '10000', '--json', 'number'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error('gh pr list did not return a JSON array');
  return parsed.length;
}

async function main(): Promise<void> {
  const repoName = argValue('--repo');
  if (!repoName) throw new Error('usage: pnpm -F web verify:pr -- --repo owner/name');

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const synced = await syncPullRequestsGraphql(client, { repo: repoName });
    await client.query('COMMIT');

    const repo = parseRepo(repoName);
    const ghCount = ghPrCount(repo.fullName);
    const dbCount = Number(
      (await pool.query('SELECT COUNT(*) AS n FROM pull_requests WHERE project_id = $1', [repo.projectId])).rows[0]?.n ?? 0,
    );

    console.log('================ Lathe PR backfill verification ================');
    console.log(`repo           : ${repo.fullName}`);
    console.log(`GitHub GraphQL : ${synced.githubCount}`);
    console.log(`gh pr list     : ${ghCount}`);
    console.log(`DB PR rows     : ${dbCount}`);
    console.log(`DB PR commits  : ${synced.prCommits}`);
    console.log('===============================================================');

    if (synced.githubCount !== ghCount) throw new Error(`GraphQL count ${synced.githubCount} != gh pr list ${ghCount}`);
    if (dbCount !== ghCount) throw new Error(`DB PR count ${dbCount} != gh pr list ${ghCount}`);
    console.log('VERDICT: GREEN — PR backfill matches gh pr list.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[verify-pr] failed: ${(error as Error).message}`);
  process.exit(1);
});
