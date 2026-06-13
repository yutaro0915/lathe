import * as fs from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import type { Built } from './built';
import { getDatabaseUrl } from '../../lib/postgres';
import {
  backfillHarnessVersions,
  isHarnessProvider,
  type HarnessSnapshot,
  upsertHarnessSnapshot,
} from './harness';

export interface InsertCounts {
  projects: number;
  sessions: number;
  events: number;
  sessionCommits: number;
  commitShaMisses: number;
  changedFiles: number;
  hunks: number;
  attributions: number;
  eventFiles: number;
  annotations: number;
  harnessVersions: number;
}

export interface InsertBuiltOptions {
  harnessSnapshots?: Map<string, HarnessSnapshot>;
  backfillHarness?: boolean;
  existingHarnessStamps?: Map<string, string>;
}

export interface ResetDatabaseOptions {
  existingHarnessStamps?: Map<string, string>;
}

function cleanParams(values: unknown[]): unknown[] {
  return values.map((value) => (typeof value === 'string' ? value.replace(/\u0000/g, '') : value));
}

export async function resetDatabase(schemaPath: string, options: ResetDatabaseOptions = {}): Promise<Pool> {
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
  if (options.existingHarnessStamps) {
    const existing = await pool.query<{ id: string; harness_version_id: string }>(
      `SELECT id,harness_version_id
         FROM sessions
        WHERE harness_version_id IS NOT NULL`,
    );
    for (const row of existing.rows) options.existingHarnessStamps.set(row.id, row.harness_version_id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM event_files');
    await client.query('DELETE FROM attributions');
    await client.query('DELETE FROM diff_hunks');
    await client.query('DELETE FROM changed_files');
    await client.query('DELETE FROM transcript_events');
    await client.query('DELETE FROM session_commits');
    await client.query('DELETE FROM pr_commits');
    await client.query('DELETE FROM pull_requests');
    await client.query('DELETE FROM github_pr_sync_state');
    await client.query('DELETE FROM annotations');
    await client.query('DELETE FROM sessions');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return pool;
}

async function prepareHarnessVersions(
  client: PoolClient,
  built: Built[],
  options: InsertBuiltOptions,
): Promise<number> {
  for (const item of built) {
    const existing = options.existingHarnessStamps?.get(item.session.id);
    if (existing) item.session.harness_version_id = existing;
  }

  for (const item of built) {
    if (item.session.harness_version_id || !isHarnessProvider(item.session.runner)) continue;
    const supplied = options.harnessSnapshots?.get(item.session.id);
    if (!supplied) continue;
    item.session.harness_version_id = await upsertHarnessSnapshot(
      client,
      item.session.projectId,
      item.session.runner,
      supplied,
    );
  }

  if (options.backfillHarness !== false) {
    const pending = built.filter(
      (item) => !item.session.harness_version_id && isHarnessProvider(item.session.runner),
    );
    if (pending.length) await backfillHarnessVersions(client, pending);
  }

  return built.filter((item) => !!item.session.harness_version_id).length;
}

function spawnAgentIdFromMeta(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.agent_id === 'string'
      ? parsed.agent_id
      : null;
  } catch {
    return null;
  }
}

async function linkSubagentSessions(client: PoolClient, built: Built[]): Promise<void> {
  const spawnLinks: Array<{
    eventId: string;
    parentSessionId: string;
    childSessionId: string;
    spawnedBySeq: number;
  }> = [];
  for (const b of built) {
    for (const e of b.events) {
      if (e.type !== 'subagent' || e.parent_id) continue;
      const childSessionId = spawnAgentIdFromMeta(e.meta);
      if (!childSessionId || childSessionId === b.session.id) continue;
      spawnLinks.push({
        eventId: e.id,
        parentSessionId: b.session.id,
        childSessionId,
        spawnedBySeq: e.seq,
      });
    }
  }
  if (!spawnLinks.length) return;

  const childIds = [...new Set(spawnLinks.map((link) => link.childSessionId))];
  const existingRows = await client.query<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ANY($1::text[])',
    [childIds],
  );
  const existingChildIds = new Set(existingRows.rows.map((row) => row.id));

  for (const link of spawnLinks) {
    if (!existingChildIds.has(link.childSessionId)) {
      await client.query(
        `UPDATE transcript_events
            SET meta = CASE WHEN meta IS NULL THEN NULL ELSE meta - 'child_session_id' END
          WHERE id = $1`,
        [link.eventId],
      );
      continue;
    }
    await client.query(
      `UPDATE sessions
          SET parent_session_id = $1,
              spawned_by_seq = $2
        WHERE id = $3`,
      [link.parentSessionId, link.spawnedBySeq, link.childSessionId],
    );
    await client.query(
      `UPDATE transcript_events
          SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('child_session_id', $1::text)
        WHERE id = $2`,
      [link.childSessionId, link.eventId],
    );
  }
}

// Incremental re-ingest of a single session (replaceBuiltSession) only carries
// that session's own events. When the re-ingested session is a sub-agent CHILD,
// its spawn_agent launcher lives in the PARENT session, so linkSubagentSessions
// (which walks the built session's events) cannot restore parent_session_id.
// Reverse-lookup the real parent from a spawn_agent event in another session
// that names this child as its agent_id, and re-establish the link.
//
// Anti-fabrication: link only when a real launcher exists in the DB. The query
// requires the launcher event (and therefore the parent session) to exist, and
// we never create a parent — absent launcher leaves parent_session_id NULL.
async function restoreSubagentParentLink(client: PoolClient, childSessionId: string): Promise<void> {
  const launcher = await client.query<{ parentSessionId: string; spawnedBySeq: number; eventId: string }>(
    `SELECT session_id AS "parentSessionId", seq AS "spawnedBySeq", id AS "eventId"
       FROM transcript_events
      WHERE type = 'subagent'
        AND parent_id IS NULL
        AND meta->>'agent_id' = $1
        AND session_id <> $1
      ORDER BY session_id ASC, seq ASC
      LIMIT 1`,
    [childSessionId],
  );
  const row = launcher.rows[0];
  if (!row) return;
  await client.query(
    `UPDATE sessions
        SET parent_session_id = $1,
            spawned_by_seq = $2
      WHERE id = $3`,
    [row.parentSessionId, row.spawnedBySeq, childSessionId],
  );
  await client.query(
    `UPDATE transcript_events
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('child_session_id', $1::text)
      WHERE id = $2`,
    [childSessionId, row.eventId],
  );
}

async function insertBuiltRows(
  client: PoolClient,
  built: Built[],
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  const validEventIds = new Set<string>();
  for (const b of built) for (const e of b.events) validEventIds.add(e.id);
  const projectIds = new Set<string>();

  const counts: InsertCounts = {
    projects: 0,
    sessions: built.length,
    events: 0,
    sessionCommits: 0,
    commitShaMisses: 0,
    changedFiles: 0,
    hunks: 0,
    attributions: 0,
    eventFiles: 0,
    annotations: 0,
    harnessVersions: 0,
  };

  for (const b of built) {
    const s = b.session;
    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint,updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         git_remote = COALESCE(EXCLUDED.git_remote, projects.git_remote),
         cwd_hint = COALESCE(EXCLUDED.cwd_hint, projects.cwd_hint),
         updated_at = CURRENT_TIMESTAMP`,
      cleanParams([s.projectId, s.project, s.projectGitRemote, s.projectCwdHint]),
    );
    projectIds.add(s.projectId);
  }
  counts.projects = projectIds.size;
  counts.harnessVersions = await prepareHarnessVersions(client, built, options);

  for (const b of built) {
    const s = b.session;
    counts.commitShaMisses += b.commitShaMissCount;

    await client.query(
      `INSERT INTO sessions (id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,harness_version_id,parent_session_id,spawned_by_seq,seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NULL,NULL,$25)`,
      cleanParams([
        s.id,
        s.projectId,
        s.project,
        s.title,
        s.runner,
        s.model,
        s.status,
        s.started_at,
        s.ended_at,
        s.duration_ms,
        s.turn_count,
        s.tool_count,
        s.edit_count,
        s.bash_count,
        s.subagent_count,
        s.error_count,
        s.token_usage,
        s.token_in,
        s.token_out,
        s.git_branch,
        s.commit_count,
        s.cost_usd,
        s.summary,
        s.harness_version_id,
        s.seq,
      ]),
    );

    for (const e of b.events) {
      await client.query(
        `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        cleanParams([
          e.id,
          e.session_id,
          e.seq,
          e.ts,
          e.type,
          e.actor,
          e.title,
          e.body,
          e.file_path,
          e.command,
          e.exit_code,
          e.duration_ms,
          e.token_usage,
          e.subagent,
          e.meta,
          e.parent_id ?? null,
        ]),
      );
      counts.events++;
    }

    for (const commit of b.sessionCommits) {
      if (commit.event_id && !validEventIds.has(commit.event_id)) continue;
      await client.query(
        `INSERT INTO session_commits (session_id,sha,event_id,source)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_id, sha) DO UPDATE SET
           event_id = EXCLUDED.event_id,
           source = EXCLUDED.source`,
        cleanParams([commit.session_id, commit.sha, commit.event_id, commit.source]),
      );
      counts.sessionCommits++;
    }

    for (const f of b.changedFiles) {
      await client.query(
        `INSERT INTO changed_files (id,session_id,path,status,additions,deletions,language,seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        cleanParams([f.id, f.session_id, f.path, f.status, f.additions, f.deletions, f.language, f.seq]),
      );
      counts.changedFiles++;
    }

    for (const h of b.hunks) {
      await client.query(
        `INSERT INTO diff_hunks (id,file_id,seq,header,content)
         VALUES ($1,$2,$3,$4,$5)`,
        cleanParams([h.id, h.file_id, h.seq, h.header, h.content]),
      );
      counts.hunks++;
    }

    for (const a of b.attributions) {
      const eventId = a.event_id && validEventIds.has(a.event_id) ? a.event_id : null;
      await client.query(
        `INSERT INTO attributions (id,hunk_id,event_id,confidence,method,note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        cleanParams([a.id, a.hunk_id, eventId, a.confidence, a.method, a.note]),
      );
      counts.attributions++;
    }

    for (const ef of b.eventFiles) {
      if (validEventIds.has(ef.event_id)) {
        await client.query(
          `INSERT INTO event_files (event_id,path,role)
           VALUES ($1,$2,$3)`,
          cleanParams([ef.event_id, ef.path, ef.role]),
        );
        counts.eventFiles++;
      }
    }

    for (const an of b.annotations) {
      await client.query(
        `INSERT INTO annotations (session_id,at_seq,kind,note)
         SELECT $1,$2,$3,$4
         WHERE NOT EXISTS (
           SELECT 1
           FROM annotations
           WHERE session_id = $1
             AND at_seq = $2
             AND kind = $3
             AND note IS NOT DISTINCT FROM $4
         )`,
        cleanParams([an.session_id, an.at_seq, an.kind, an.note]),
      );
      counts.annotations++;
    }
  }

  await linkSubagentSessions(client, built);

  return counts;
}

async function insertBuiltWithClient(
  client: PoolClient,
  built: Built[],
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  await client.query('BEGIN');
  try {
    const counts = await insertBuiltRows(client, built, options);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function deleteSessionRows(client: PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `DELETE FROM event_files
     WHERE event_id IN (SELECT id FROM transcript_events WHERE session_id = $1)`,
    [sessionId],
  );
  await client.query('DELETE FROM session_commits WHERE session_id = $1', [sessionId]);
  await client.query(
    `DELETE FROM attributions
     WHERE hunk_id IN (
       SELECT h.id
       FROM diff_hunks h
       JOIN changed_files f ON f.id = h.file_id
       WHERE f.session_id = $1
     )
     OR event_id IN (SELECT id FROM transcript_events WHERE session_id = $1)`,
    [sessionId],
  );
  await client.query(
    `DELETE FROM diff_hunks
     WHERE file_id IN (SELECT id FROM changed_files WHERE session_id = $1)`,
    [sessionId],
  );
  await client.query('DELETE FROM changed_files WHERE session_id = $1', [sessionId]);
  await client.query('DELETE FROM transcript_events WHERE session_id = $1', [sessionId]);
  await client.query('DELETE FROM annotations WHERE session_id = $1', [sessionId]);
  await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

async function seqForReplacement(client: PoolClient, sessionId: string, requestedSeq: number): Promise<number> {
  const existing = await client.query<{ seq: number }>('SELECT seq FROM sessions WHERE id = $1', [sessionId]);
  if (existing.rows[0]) return existing.rows[0].seq;
  if (requestedSeq > 0) return requestedSeq;

  const first = await client.query<{ min_seq: number | null }>('SELECT MIN(seq) AS min_seq FROM sessions');
  const minSeq = first.rows[0]?.min_seq;
  return minSeq == null ? 1 : minSeq - 1;
}

export async function insertBuilt(
  pool: Pool,
  built: Built[],
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  const client = await pool.connect();
  try {
    return await insertBuiltWithClient(client, built, options);
  } finally {
    client.release();
  }
}

export async function replaceBuiltSession(
  pool: Pool,
  built: Built,
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    built.session.seq = await seqForReplacement(client, built.session.id, built.session.seq);
    await deleteSessionRows(client, built.session.id);
    const counts = await insertBuiltRows(client, [built], options);
    await restoreSubagentParentLink(client, built.session.id);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
