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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function graphqlPr(number: number) {
  const oid = number === 1
    ? '1111111111111111111111111111111111111111'
    : '2222222222222222222222222222222222222222';
  return {
    id: `node-${number}`,
    number,
    title: `Fixture PR ${number}`,
    body: `Fixture body ${number}`,
    state: 'OPEN',
    url: `https://github.com/lathe-etag-fixture/repo/pull/${number}`,
    author: { login: 'fixture' },
    headRefName: `fixture/pr-${number}`,
    headRefOid: oid,
    baseRefName: 'main',
    additions: number,
    deletions: 0,
    changedFiles: 1,
    createdAt: `2026-06-11T00:0${number}:00Z`,
    updatedAt: `2026-06-11T00:0${number}:30Z`,
    mergedAt: null,
    commits: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ commit: { oid, committedDate: `2026-06-11T00:0${number}:00Z` } }],
    },
    reviews: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ state: 'APPROVED', author: { login: 'reviewer' }, body: 'ok', submittedAt: `2026-06-11T00:0${number}:10Z` }],
    },
  };
}

async function main(): Promise<void> {
  const repo = parseRepo('lathe-etag-fixture/repo');
  const oldEtag = '"lathe-etag-fixture"';
  const newEtag = '"lathe-etag-fixture-new"';
  let mode: 'not-modified' | 'changed' = 'not-modified';
  let receivedIfNoneMatch: string | undefined;
  let requestedGetUrl = '';
  let pagedGetCount = 0;
  const graphqlNumbers: number[] = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const number = Number(body?.variables?.number);
      graphqlNumbers.push(number);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { repository: { pullRequest: graphqlPr(number) } } }));
      return;
    }

    requestedGetUrl = req.url ?? '';
    const header = req.headers['if-none-match'];
    const currentIfNoneMatch = Array.isArray(header) ? header.join(', ') : header;
    if (currentIfNoneMatch) receivedIfNoneMatch = currentIfNoneMatch;

    if (mode === 'not-modified') {
      res.statusCode = 304;
      res.setHeader('etag', oldEtag);
      res.end();
      return;
    }

    pagedGetCount++;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('etag', newEtag);
    if (!requestedGetUrl.includes('page=2')) {
      const nextUrl = `http://127.0.0.1:${port}/repos/lathe-etag-fixture/repo/issues?state=all&since=2026-01-01T00%3A00%3A00Z&per_page=100&page=2`;
      res.setHeader('link', `<${nextUrl}>; rel="next"`);
      res.end(JSON.stringify([{ number: 1, updated_at: '2026-06-11T00:01:30Z', pull_request: { url: 'pr-1' } }]));
    } else {
      res.end(JSON.stringify([{ number: 2, updated_at: '2026-06-11T00:02:30Z', pull_request: { url: 'pr-2' } }]));
    }
  });
  const port = await listen(server);

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM pr_commits WHERE pr_id LIKE $1', [`${repo.projectId}#%`]);
    await client.query('DELETE FROM pull_requests WHERE project_id = $1', [repo.projectId]);
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
      [repo.projectId, repo.fullName, oldEtag, '2026-01-01T00:00:00Z'],
    );

    const logs304: string[] = [];
    const result304 = await pollPullRequestsIncremental(client, {
      repo: repo.fullName,
      token: 'test-token',
      apiBaseUrl: `http://127.0.0.1:${port}`,
      graphqlUrl: `http://127.0.0.1:${port}/graphql`,
      log: (line) => logs304.push(line),
    });

    mode = 'changed';
    pagedGetCount = 0;
    graphqlNumbers.length = 0;
    const logs200: string[] = [];
    const result200 = await pollPullRequestsIncremental(client, {
      repo: repo.fullName,
      token: 'test-token',
      apiBaseUrl: `http://127.0.0.1:${port}`,
      graphqlUrl: `http://127.0.0.1:${port}/graphql`,
      log: (line) => logs200.push(line),
    });
    const dbCounts = (
      await client.query<{ prs: string; commits: string }>(
        `SELECT
           (SELECT COUNT(*) FROM pull_requests WHERE project_id = $1) AS prs,
           (SELECT COUNT(*)
              FROM pr_commits pc
              JOIN pull_requests pr ON pr.id = pc.pr_id
             WHERE pr.project_id = $1) AS commits`,
        [repo.projectId],
      )
    ).rows[0];

    console.log('================ Lathe PR ETag verification ================');
    console.log(`request url          : ${requestedGetUrl}`);
    console.log(`If-None-Match sent   : ${receivedIfNoneMatch ?? '(none)'}`);
    console.log(`304 status path      : ${result304.status}`);
    console.log(`304 log              : ${logs304.join(' | ')}`);
    console.log(`200 status path      : ${result200.status}`);
    console.log(`200 changed PRs      : ${result200.changedPulls}`);
    console.log(`200 paged GETs       : ${pagedGetCount}`);
    console.log(`GraphQL PR numbers   : ${graphqlNumbers.join(', ')}`);
    console.log(`DB PR rows           : ${dbCounts?.prs ?? '0'}`);
    console.log(`DB PR commits        : ${dbCounts?.commits ?? '0'}`);
    console.log('============================================================');

    if (receivedIfNoneMatch !== oldEtag) throw new Error(`If-None-Match header mismatch: ${receivedIfNoneMatch ?? '(none)'}`);
    if (!result304.sentIfNoneMatch) throw new Error('poll result did not record If-None-Match usage');
    if (result304.status !== 'not_modified') throw new Error(`expected 304 not_modified path, got ${result304.status}`);
    if (!logs304.some((line) => line.includes('status=304'))) throw new Error('304 path was not logged');
    if (result200.status !== 'changed') throw new Error(`expected 200 changed path, got ${result200.status}`);
    if (result200.changedPulls !== 2) throw new Error(`expected 2 changed PRs, got ${result200.changedPulls}`);
    if (pagedGetCount !== 2) throw new Error(`expected Link pagination to fetch 2 pages, got ${pagedGetCount}`);
    if (graphqlNumbers.join(',') !== '1,2') throw new Error(`expected GraphQL refetch for PRs 1,2, got ${graphqlNumbers.join(',')}`);
    if (Number(dbCounts?.prs ?? 0) !== 2) throw new Error('200 path did not upsert changed pull_requests');
    if (Number(dbCounts?.commits ?? 0) !== 2) throw new Error('200 path did not upsert changed pr_commits');
    console.log('VERDICT: GREEN — incremental polling sends ETag, handles 304, pages 200 responses, and upserts changed PRs.');
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
