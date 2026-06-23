import type {
  ChangedFile,
  DiffHunk,
  PullRequest,
  PullRequestBundle,
  PullRequestSessionLink,
  PullRequestSummary,
} from '../types';
import { queryOne, queryRows } from '../db.query';
import {
  type ChangedFileRow,
  type DiffHunkRow,
  type PullRequestLinkRow,
  type PullRequestRow,
  type SessionPrSummaryRow,
  type SessionRow,
  toChangedFile,
  toHunk,
  toPullRequest,
  toPullRequestSummary,
  toSession,
} from './rows';

interface PullRequestDiffBundle {
  changedFiles: ChangedFile[];
  hunks: Record<string, DiffHunk[]>;
}

export async function listPullRequests(): Promise<PullRequestSummary[]> {
  const rows = await queryRows<PullRequestRow>(
    `SELECT *
       FROM pull_requests
      ORDER BY updated_at DESC, project_id ASC, number DESC`,
  );
  return rows.map((row) => toPullRequestSummary(row));
}

export async function getPullRequest(id: string): Promise<PullRequest | undefined> {
  const row = await queryOne<PullRequestRow>('SELECT * FROM pull_requests WHERE id = $1', [id]);
  return row ? toPullRequest(row) : undefined;
}

export async function getPullRequestsForSession(sessionId: string): Promise<PullRequestSummary[]> {
  const rows = await queryRows<PullRequestLinkRow>(
    `SELECT pr.*, spr.source AS link_method, spr.source, spr.pr_updated_at
       FROM session_pull_requests spr
       JOIN pull_requests pr ON pr.id = spr.pr_id
      WHERE spr.session_id = $1
      ORDER BY spr.pr_updated_at DESC, pr.number DESC`,
    [sessionId],
  );
  return rows.map((row) => toPullRequestSummary(row, row.link_method));
}

export async function getSessionPrSummary(): Promise<Record<string, PullRequestSummary[]>> {
  const rows = await queryRows<SessionPrSummaryRow>(
    `SELECT spr.session_id,
            pr.id, pr.project_id, pr.number, pr.title, pr.state, pr.url,
            pr.head_ref_name, pr.merged_at, pr.updated_at, spr.source AS link_method, spr.source, spr.pr_updated_at
       FROM session_pull_requests spr
       JOIN pull_requests pr ON pr.id = spr.pr_id
      ORDER BY spr.pr_updated_at DESC, pr.number DESC`,
  );
  const out: Record<string, PullRequestSummary[]> = {};
  for (const row of rows) (out[row.session_id] ??= []).push(toPullRequestSummary(row, row.link_method));
  return out;
}

export async function getSessionsForPullRequest(prId: string): Promise<PullRequestSessionLink[]> {
  const rows = await queryRows<SessionRow & { link_method: string; matched_sha: string | null }>(
    `SELECT s.*, spr.source AS link_method,
            (
              SELECT pc.sha
                FROM pr_commits pc
                JOIN session_commits sc
                  ON sc.session_id = s.id
                 AND LENGTH(sc.sha) >= 7
                 AND LOWER(pc.sha) LIKE LOWER(sc.sha) || '%'
               WHERE pc.pr_id = spr.pr_id
               ORDER BY LENGTH(sc.sha) DESC, pc.sha ASC
               LIMIT 1
            ) AS matched_sha
       FROM session_pull_requests spr
       JOIN sessions s ON s.id = spr.session_id
      WHERE spr.pr_id = $1
      ORDER BY spr.pr_updated_at DESC, s.seq ASC`,
    [prId],
  );
  return rows.map((row) => ({
    session: toSession(row),
    linkMethod: row.link_method as 'sha' | 'branch',
    matchedSha: row.matched_sha,
  }));
}

export async function getPullRequestBundle(id: string): Promise<PullRequestBundle | undefined> {
  const pullRequest = await getPullRequest(id);
  if (!pullRequest) return undefined;
  const linkedSessions = await getSessionsForPullRequest(id);
  const diff = await getPullRequestLinkedDiff(linkedSessions.map((link) => link.session.id));
  return {
    pullRequest,
    linkedSessions,
    changedFiles: diff.changedFiles,
    hunks: diff.hunks,
  };
}

async function getPullRequestLinkedDiff(sessionIds: string[]): Promise<PullRequestDiffBundle> {
  if (sessionIds.length === 0) return { changedFiles: [], hunks: {} };

  const fileRows = await queryRows<ChangedFileRow>(
    `SELECT *
       FROM changed_files
      WHERE session_id = ANY($1::text[])
      ORDER BY session_id ASC, seq ASC`,
    [sessionIds],
  );
  const changedFiles = fileRows.map(toChangedFile);
  const fileIds = changedFiles.map((file) => file.id);
  if (fileIds.length === 0) return { changedFiles, hunks: {} };

  const hunkRows = await queryRows<DiffHunkRow>(
    `SELECT *
       FROM diff_hunks
      WHERE file_id = ANY($1::text[])
      ORDER BY file_id ASC, seq ASC`,
    [fileIds],
  );
  const hunks: Record<string, DiffHunk[]> = {};
  for (const row of hunkRows) {
    const hunk = toHunk(row);
    (hunks[hunk.fileId] ??= []).push(hunk);
  }
  return { changedFiles, hunks };
}
