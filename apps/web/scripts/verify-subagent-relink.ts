// Verifies issue #10: incremental re-ingest of a sub-agent CHILD session must
// not drop its parent_session_id link. The launcher (spawn_agent) lives in the
// PARENT session, so replaceBuiltSession([child]) cannot rediscover the link by
// walking the child's own events — it must reverse-look-up the real parent.
//
// Runs against an isolated scratch schema (created + dropped here) so the shared
// dev database is never touched. Checks:
//   (a) full ingest links child -> parent and stamps launcher.child_session_id
//   (b) child-only incremental re-ingest preserves that link
//   (c) anti-fabrication: an orphan child (no launcher) keeps parent NULL
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { insertBuilt, replaceBuiltSession } from './ingest/repository/ingest-writer';
import type { Built } from './ingest/built';
import { withScratchDatabase } from './verify/scratch';

const PROJECT = 'fixture:relink';
const PARENT = 'relink-parent-0001';
const CHILD = 'relink-child-0002';
const ORPHAN = 'relink-orphan-0003';

function assertOk(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function baseSession(id: string, overrides: Partial<Built['session']> = {}): Built['session'] {
  return {
    id,
    projectId: PROJECT,
    project: 'Relink Fixture',
    projectGitRemote: null,
    projectCwdHint: null,
    title: id,
    runner: 'codex',
    model: 'gpt-5.3-codex',
    status: 'done',
    started_at: '2026-06-13 00:00:00',
    ended_at: '2026-06-13 00:00:01',
    duration_ms: 1000,
    turn_count: 1,
    tool_count: 1,
    edit_count: 0,
    bash_count: 0,
    subagent_count: 0,
    error_count: 0,
    token_usage: 0,
    token_in: 0,
    token_out: 0,
    git_branch: 'fix/issue-10-subagent-relink',
    commit_count: 0,
    cost_usd: null,
    summary: 'relink fixture',
    harness_version_id: null,
    parent_session_id: null,
    spawned_by_seq: null,
    seq: 1,
    _startMs: 0,
    ...overrides,
  };
}

// Parent session whose seq-2 event spawns CHILD (meta.agent_id = CHILD).
function parentBuilt(): Built {
  return {
    session: baseSession(PARENT, { subagent_count: 1, seq: 10 }),
    events: [
      {
        id: `${PARENT}_1`,
        session_id: PARENT,
        seq: 1,
        ts: '00:00:00',
        type: 'user_message',
        actor: 'user',
        title: 'spawn a child',
        body: 'spawn a child',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: null,
        meta: null,
        parent_id: null,
      },
      {
        id: `${PARENT}_2`,
        session_id: PARENT,
        seq: 2,
        ts: '00:00:01',
        type: 'subagent',
        actor: 'assistant',
        title: 'Sub-agent · explorer',
        body: 'spawn_agent',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: 'explorer',
        meta: JSON.stringify({ tool: 'spawn_agent', agent_id: CHILD }),
        parent_id: null,
      },
    ],
    sessionCommits: [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

// Child / orphan session: only its own events, no spawn_agent launcher.
function childBuilt(id: string): Built {
  return {
    session: baseSession(id, { seq: 20 }),
    events: [
      {
        id: `${id}_1`,
        session_id: id,
        seq: 1,
        ts: '00:00:00',
        type: 'user_message',
        actor: 'user',
        title: 'child task',
        body: 'child task',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: null,
        meta: null,
        parent_id: null,
      },
      {
        id: `${id}_2`,
        session_id: id,
        seq: 2,
        ts: '00:00:01',
        type: 'assistant_message',
        actor: 'assistant',
        title: 'child reply',
        body: 'child reply',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: null,
        meta: null,
        parent_id: null,
      },
    ],
    sessionCommits: [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

interface LinkRow {
  parent_session_id: string | null;
  spawned_by_seq: number | null;
}

async function childLink(pool: Pool, id: string): Promise<LinkRow | undefined> {
  const res = await pool.query<LinkRow>(
    'SELECT parent_session_id, spawned_by_seq FROM sessions WHERE id = $1',
    [id],
  );
  return res.rows[0];
}

async function launcherStamp(pool: Pool): Promise<string | null> {
  const res = await pool.query<{ child_session_id: string | null }>(
    `SELECT meta->>'child_session_id' AS child_session_id FROM transcript_events WHERE id = $1`,
    [`${PARENT}_2`],
  );
  return res.rows[0]?.child_session_id ?? null;
}

async function main(): Promise<void> {
  await withScratchDatabase('relink_test', async ({ createPool }) => {
    const scratch = createPool();
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    try {
      await scratch.query(schemaSql);

      // (a) full ingest establishes the link.
      await insertBuilt(scratch, [parentBuilt(), childBuilt(CHILD), childBuilt(ORPHAN)], {
        backfillHarness: false,
      });
      let link = await childLink(scratch, CHILD);
      assertOk(link, 'child session was not inserted by full ingest');
      assertOk(
        link?.parent_session_id === PARENT,
        `full ingest: child parent_session_id=${link?.parent_session_id} expected ${PARENT}`,
      );
      assertOk(
        link?.spawned_by_seq === 2,
        `full ingest: child spawned_by_seq=${link?.spawned_by_seq} expected 2`,
      );
      assertOk(
        (await launcherStamp(scratch)) === CHILD,
        'full ingest: launcher meta.child_session_id was not stamped',
      );
      const orphan = await childLink(scratch, ORPHAN);
      assertOk(
        orphan?.parent_session_id == null,
        `full ingest: orphan child fabricated parent_session_id=${orphan?.parent_session_id}`,
      );

      // (b) child-only incremental re-ingest preserves the link.
      await replaceBuiltSession(scratch, childBuilt(CHILD), { backfillHarness: false });
      link = await childLink(scratch, CHILD);
      assertOk(link, 'child session disappeared after incremental re-ingest');
      assertOk(
        link?.parent_session_id === PARENT,
        `incremental: child parent_session_id=${link?.parent_session_id} expected ${PARENT} (issue #10 regression)`,
      );
      assertOk(
        link?.spawned_by_seq === 2,
        `incremental: child spawned_by_seq=${link?.spawned_by_seq} expected 2`,
      );
      assertOk(
        (await launcherStamp(scratch)) === CHILD,
        'incremental: launcher meta.child_session_id lost after re-ingest',
      );

      // (c) anti-fabrication: re-ingesting an orphan never invents a parent.
      await replaceBuiltSession(scratch, childBuilt(ORPHAN), { backfillHarness: false });
      const orphanAfter = await childLink(scratch, ORPHAN);
      assertOk(
        orphanAfter?.parent_session_id == null,
        `incremental: orphan child fabricated parent_session_id=${orphanAfter?.parent_session_id}`,
      );

      console.log('================ Lathe sub-agent relink verification ================');
      console.log('full ingest      : child linked to parent, launcher stamped');
      console.log('incremental      : child link preserved after child-only re-ingest');
      console.log('anti-fabrication : orphan child stays unlinked (no invented parent)');
      console.log('=====================================================================');
      console.log('VERDICT: GREEN — incremental re-ingest restores the real parent link (#10).');
    } finally {
      await scratch.end().catch(() => undefined);
    }
  });
}

main().catch((error) => {
  console.error(`[verify-subagent-relink] failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
