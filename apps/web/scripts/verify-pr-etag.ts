import * as http from 'node:http';
import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { parseRepo, pollPullRequestsIncremental } from './ingest/github';

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) resolve(address.port);
      else reject(new Error('failed to bind test server'));
    });
  });
}

async function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function main(): Promise<void> {
  const repo = parseRepo('lathe-etag-fixture/repo');
  const etag = '"lathe-etag-fixture"';
  let receivedIfNoneMatch: string | undefined;
  let requestedUrl = '';

  const server = http.createServer((req, res) => {
    requestedUrl = req.url ?? '';
    const header = req.headers['if-none-match'];
    receivedIfNoneMatch = Array.isArray(header) ? header.join(', ') : header;
    res.statusCode = 304;
    res.setHeader('etag', etag);
    res.end();
  });
  const port = await listen(server);

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint,updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
      [repo.projectId, repo.fullName, repo.remoteUrl, null],
    );
    await client.query(
      `INSERT INTO github_pr_sync_state (project_id,repo_full_name,issues_etag,last_issue_since,updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (project_id) DO UPDATE SET
         repo_full_name = EXCLUDED.repo_full_name,
         issues_etag = EXCLUDED.issues_etag,
         last_issue_since = EXCLUDED.last_issue_since,
         updated_at = CURRENT_TIMESTAMP`,
      [repo.projectId, repo.fullName, etag, '2026-01-01T00:00:00Z'],
    );

    const logs: string[] = [];
    const result = await pollPullRequestsIncremental(client, {
      repo: repo.fullName,
      token: 'test-token',
      apiBaseUrl: `http://127.0.0.1:${port}`,
      log: (line) => logs.push(line),
    });

    console.log('================ Lathe PR ETag verification ================');
    console.log(`request url       : ${requestedUrl}`);
    console.log(`If-None-Match sent: ${receivedIfNoneMatch ?? '(none)'}`);
    console.log(`status path       : ${result.status}`);
    console.log(`log               : ${logs.join(' | ')}`);
    console.log('============================================================');

    if (receivedIfNoneMatch !== etag) throw new Error(`If-None-Match header mismatch: ${receivedIfNoneMatch ?? '(none)'}`);
    if (!result.sentIfNoneMatch) throw new Error('poll result did not record If-None-Match usage');
    if (result.status !== 'not_modified') throw new Error(`expected 304 not_modified path, got ${result.status}`);
    if (!logs.some((line) => line.includes('status=304'))) throw new Error('304 path was not logged');
    console.log('VERDICT: GREEN — incremental polling sends ETag and handles 304.');
  } finally {
    client.release();
    await pool.end();
    await close(server);
  }
}

main().catch((error) => {
  console.error(`[verify-pr-etag] failed: ${(error as Error).message}`);
  process.exit(1);
});
