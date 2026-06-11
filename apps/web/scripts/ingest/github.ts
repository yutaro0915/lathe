import { execFileSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { normalizeGitRemoteUrl } from './project';

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  projectId: string;
  remoteUrl: string;
}

export interface SyncOptions {
  repo: string;
  token?: string;
  graphqlUrl?: string;
  apiBaseUrl?: string;
  log?: (line: string) => void;
}

interface GraphqlPage {
  repository: {
    pullRequests: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GraphqlPullRequest[];
    };
  } | null;
}

interface GraphqlPullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  author: { login: string } | null;
  headRefName: string | null;
  headRefOid: string | null;
  baseRefName: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  commits: {
    nodes: { commit: { oid: string; committedDate: string | null } }[];
  };
  reviews: {
    totalCount: number;
    nodes: { state: string; author: { login: string } | null; body: string; submittedAt: string | null }[];
  };
}

export interface PullRequestSyncResult {
  repo: RepoRef;
  githubCount: number;
  dbCount: number;
  prCommits: number;
}

export interface IncrementalPollResult {
  repo: RepoRef;
  status: 'not_modified' | 'changed';
  sentIfNoneMatch: boolean;
  etag: string | null;
  changedPulls: number;
}

export function resolveGitHubToken(): string {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }

  throw new Error('GitHub token not found: set GITHUB_TOKEN or run gh auth login');
}

export function parseRepo(repo: string): RepoRef {
  const cleaned = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [owner, name, extra] = cleaned.split('/');
  if (!owner || !name || extra) throw new Error(`repo must be owner/name: ${repo}`);
  const remoteUrl = `https://github.com/${owner}/${name}.git`;
  const projectId = normalizeGitRemoteUrl(remoteUrl);
  if (!projectId) throw new Error(`failed to normalize repo: ${repo}`);
  return { owner, name, fullName: `${owner}/${name}`, projectId, remoteUrl };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'lathe-pr-linkage',
    'x-github-api-version': '2022-11-28',
  };
}

async function graphql<T>(url: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub GraphQL failed (${response.status}): ${JSON.stringify(body)}`);
  if (body?.errors?.length) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

const PR_BACKFILL_QUERY = `
query LathePullRequests($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        body
        state
        url
        author { login }
        headRefName
        headRefOid
        baseRefName
        additions
        deletions
        changedFiles
        createdAt
        updatedAt
        mergedAt
        commits(first: 100) {
          nodes { commit { oid committedDate } }
        }
        reviews(first: 100) {
          totalCount
          nodes { state author { login } body submittedAt }
        }
      }
    }
  }
}
`;

async function ensureProject(client: PoolClient, repo: RepoRef): Promise<void> {
  await client.query(
    `INSERT INTO projects (id,display_name,git_remote,cwd_hint,updated_at)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       git_remote = EXCLUDED.git_remote,
       updated_at = CURRENT_TIMESTAMP`,
    [repo.projectId, repo.fullName, repo.remoteUrl, null],
  );
}

async function upsertPullRequest(client: PoolClient, repo: RepoRef, pr: GraphqlPullRequest): Promise<void> {
  const id = `${repo.projectId}#${pr.number}`;
  await client.query(
    `INSERT INTO pull_requests (
       id,project_id,number,node_id,title,body,state,url,author_login,
       head_ref_name,head_sha,base_ref_name,additions,deletions,changed_files,
       review_count,reviews,created_at,updated_at,merged_at,synced_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,CURRENT_TIMESTAMP)
     ON CONFLICT (project_id, number) DO UPDATE SET
       node_id = EXCLUDED.node_id,
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       state = EXCLUDED.state,
       url = EXCLUDED.url,
       author_login = EXCLUDED.author_login,
       head_ref_name = EXCLUDED.head_ref_name,
       head_sha = EXCLUDED.head_sha,
       base_ref_name = EXCLUDED.base_ref_name,
       additions = EXCLUDED.additions,
       deletions = EXCLUDED.deletions,
       changed_files = EXCLUDED.changed_files,
       review_count = EXCLUDED.review_count,
       reviews = EXCLUDED.reviews,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       merged_at = EXCLUDED.merged_at,
       synced_at = CURRENT_TIMESTAMP`,
    [
      id,
      repo.projectId,
      pr.number,
      pr.id,
      pr.title,
      pr.body,
      pr.state.toLowerCase(),
      pr.url,
      pr.author?.login ?? null,
      pr.headRefName,
      pr.headRefOid,
      pr.baseRefName,
      pr.additions,
      pr.deletions,
      pr.changedFiles,
      pr.reviews.totalCount,
      JSON.stringify(pr.reviews.nodes ?? []),
      pr.createdAt,
      pr.updatedAt,
      pr.mergedAt,
    ],
  );

  await client.query('DELETE FROM pr_commits WHERE pr_id = $1', [id]);
  for (const node of pr.commits.nodes ?? []) {
    await client.query(
      `INSERT INTO pr_commits (pr_id,sha,committed_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (pr_id, sha) DO UPDATE SET committed_at = EXCLUDED.committed_at`,
      [id, node.commit.oid.toLowerCase(), node.commit.committedDate],
    );
  }
}

export async function syncPullRequestsGraphql(client: PoolClient, options: SyncOptions): Promise<PullRequestSyncResult> {
  const repo = parseRepo(options.repo);
  const token = options.token ?? resolveGitHubToken();
  const graphqlUrl = options.graphqlUrl ?? 'https://api.github.com/graphql';
  const log = options.log ?? console.log;

  await ensureProject(client, repo);

  let cursor: string | null = null;
  let githubCount = 0;
  let fetched = 0;
  do {
    const data: GraphqlPage = await graphql<GraphqlPage>(graphqlUrl, token, PR_BACKFILL_QUERY, {
      owner: repo.owner,
      name: repo.name,
      cursor,
    });
    const connection = data.repository?.pullRequests;
    if (!connection) throw new Error(`repository not found: ${repo.fullName}`);
    githubCount = connection.totalCount;
    for (const pr of connection.nodes ?? []) {
      await upsertPullRequest(client, repo, pr);
      fetched++;
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  await client.query(
    `INSERT INTO github_pr_sync_state (project_id,repo_full_name,last_backfill_at,updated_at)
     VALUES ($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_full_name = EXCLUDED.repo_full_name,
       last_backfill_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [repo.projectId, repo.fullName],
  );

  const dbCount = Number(
    (await client.query('SELECT COUNT(*) AS n FROM pull_requests WHERE project_id = $1', [repo.projectId])).rows[0]?.n ?? 0,
  );
  const prCommits = Number(
    (
      await client.query(
        `SELECT COUNT(*) AS n
           FROM pr_commits pc
           JOIN pull_requests pr ON pr.id = pc.pr_id
          WHERE pr.project_id = $1`,
        [repo.projectId],
      )
    ).rows[0]?.n ?? 0,
  );
  log(`[pr-sync] graphql repo=${repo.fullName} fetched=${fetched} github_count=${githubCount} db_count=${dbCount}`);
  return { repo, githubCount, dbCount, prCommits };
}

export async function pollPullRequestsIncremental(client: PoolClient, options: SyncOptions): Promise<IncrementalPollResult> {
  const repo = parseRepo(options.repo);
  const token = options.token ?? resolveGitHubToken();
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  const log = options.log ?? console.log;
  await ensureProject(client, repo);

  const state = (
    await client.query<{ issues_etag: string | null; last_issue_since: string | null }>(
      'SELECT issues_etag,last_issue_since FROM github_pr_sync_state WHERE project_id = $1',
      [repo.projectId],
    )
  ).rows[0];
  const since = state?.last_issue_since ?? '1970-01-01T00:00:00Z';
  const headers = githubHeaders(token);
  if (state?.issues_etag) headers['if-none-match'] = state.issues_etag;

  const url = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repo.owner}/${repo.name}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100`;
  const response = await fetch(url, { headers });
  const etag = response.headers.get('etag') ?? state?.issues_etag ?? null;
  const sentIfNoneMatch = !!state?.issues_etag;

  if (response.status === 304) {
    await client.query(
      `INSERT INTO github_pr_sync_state (project_id,repo_full_name,issues_etag,last_issue_since,last_incremental_at,updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
       ON CONFLICT (project_id) DO UPDATE SET
         repo_full_name = EXCLUDED.repo_full_name,
         issues_etag = EXCLUDED.issues_etag,
         last_issue_since = EXCLUDED.last_issue_since,
         last_incremental_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [repo.projectId, repo.fullName, etag, since],
    );
    log(`[pr-sync] incremental repo=${repo.fullName} status=304 etag=${etag ?? '(none)'}`);
    return { repo, status: 'not_modified', sentIfNoneMatch, etag, changedPulls: 0 };
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub REST issues failed (${response.status}): ${JSON.stringify(body)}`);
  const issues = Array.isArray(body) ? body : [];
  const changedPulls = issues.filter((issue) => issue?.pull_request).length;
  const newest = issues
    .map((issue) => (typeof issue?.updated_at === 'string' ? issue.updated_at : null))
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);

  await client.query(
    `INSERT INTO github_pr_sync_state (project_id,repo_full_name,issues_etag,last_issue_since,last_incremental_at,updated_at)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_full_name = EXCLUDED.repo_full_name,
       issues_etag = EXCLUDED.issues_etag,
       last_issue_since = EXCLUDED.last_issue_since,
       last_incremental_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [repo.projectId, repo.fullName, etag, newest ?? since],
  );

  log(`[pr-sync] incremental repo=${repo.fullName} status=${response.status} changed_prs=${changedPulls} etag=${etag ?? '(none)'}`);
  return { repo, status: 'changed', sentIfNoneMatch, etag, changedPulls };
}
