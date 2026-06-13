import { Pool } from 'pg';
import { closePool, queryRows } from '../lib/postgres';
import { getStats } from '../lib/db';
import { getDatabaseUrl } from '../lib/postgres';
import { insertBuilt } from './ingest/db';
import type { Built } from './ingest/built';

const REAL_PARENT = '019e67d2-a807-74c2-8001-26e057777bb1';
const REAL_CHILD = '019e69f2-5b60-7c01-9f7b-a3d71fa463e8';

interface SpawnRow {
  event_id: string;
  parent_session_id: string;
  spawned_by_seq: number;
  agent_id: string | null;
  child_session_id: string | null;
  child_exists: boolean;
  linked_parent_session_id: string | null;
  linked_spawned_by_seq: number | null;
}

interface DanglingEventRow {
  event_id: string;
  child_session_id: string;
}

interface FabricatedSessionRow {
  id: string;
  parent_session_id: string;
  spawned_by_seq: number | null;
}

interface TotalsRow {
  sessions: number;
  tokens: number;
  cost: number;
}

const MISSING_FIXTURE_PROJECT = 'fixture:verify-subagent-missing-child';
const MISSING_FIXTURE_PARENT = 'fixture-verify-subagent-missing-parent';
const MISSING_FIXTURE_AGENT = 'fixture-verify-subagent-absent-child';

function assertOk(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function cleanupMissingFixture(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM transcript_events WHERE session_id = $1', [MISSING_FIXTURE_PARENT]);
  await pool.query('DELETE FROM sessions WHERE id = $1', [MISSING_FIXTURE_PARENT]);
  await pool.query('DELETE FROM projects WHERE id = $1', [MISSING_FIXTURE_PROJECT]);
}

function missingChildBuilt(): Built {
  return {
    session: {
      id: MISSING_FIXTURE_PARENT,
      projectId: MISSING_FIXTURE_PROJECT,
      project: 'Verify Sub-agent Missing Child',
      projectGitRemote: null,
      projectCwdHint: null,
      title: 'Verify missing child is not fabricated',
      runner: 'codex',
      model: 'gpt-5.3-codex',
      status: 'done',
      started_at: '2026-06-12 00:00:00',
      ended_at: '2026-06-12 00:00:01',
      duration_ms: 1000,
      turn_count: 1,
      tool_count: 1,
      edit_count: 0,
      bash_count: 0,
      subagent_count: 1,
      error_count: 0,
      token_usage: 0,
      token_in: 0,
      token_out: 0,
      git_branch: 'loop/19-subagent-linking',
      commit_count: 0,
      cost_usd: null,
      summary: 'verify fixture',
      harness_version_id: null,
      parent_session_id: null,
      spawned_by_seq: null,
      seq: 999999,
      _startMs: 0,
    },
    events: [
      {
        id: `${MISSING_FIXTURE_PARENT}_1`,
        session_id: MISSING_FIXTURE_PARENT,
        seq: 1,
        ts: '00:00:00',
        type: 'user_message',
        actor: 'user',
        title: 'verify missing child',
        body: 'verify missing child',
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
        id: `${MISSING_FIXTURE_PARENT}_2`,
        session_id: MISSING_FIXTURE_PARENT,
        seq: 2,
        ts: '00:00:01',
        type: 'subagent',
        actor: 'assistant',
        title: 'Sub-agent · explorer',
        body: 'missing child fixture',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: 'explorer',
        meta: JSON.stringify({ tool: 'spawn_agent', agent_id: MISSING_FIXTURE_AGENT }),
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

async function verifyMissingChildIsNotFabricated(): Promise<void> {
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    await cleanupMissingFixture(pool);
    await insertBuilt(pool, [missingChildBuilt()], { backfillHarness: false });
    const event = (
      await pool.query<{ child_session_id: string | null }>(
        `SELECT meta->>'child_session_id' AS child_session_id
           FROM transcript_events
          WHERE id = $1`,
        [`${MISSING_FIXTURE_PARENT}_2`],
      )
    ).rows[0];
    assertOk(event, 'missing-child fixture launcher was not inserted');
    assertOk(event.child_session_id == null, 'missing-child fixture incorrectly stamped child_session_id');
    const fabricated = (
      await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM sessions
          WHERE id = $1
             OR parent_session_id = $2`,
        [MISSING_FIXTURE_AGENT, MISSING_FIXTURE_PARENT],
      )
    ).rows[0]?.n ?? 0;
    assertOk(fabricated === 0, `missing-child fixture fabricated ${fabricated} child session link(s)`);
  } finally {
    await cleanupMissingFixture(pool).catch(() => undefined);
    await pool.end();
  }
}

async function main(): Promise<void> {
  const spawns = await queryRows<SpawnRow>(
    `WITH spawn_events AS (
       SELECT id AS event_id,
              session_id AS parent_session_id,
              seq AS spawned_by_seq,
              meta->>'agent_id' AS agent_id,
              meta->>'child_session_id' AS child_session_id
         FROM transcript_events
        WHERE type = 'subagent'
          AND parent_id IS NULL
          AND meta->>'tool' = 'spawn_agent'
          AND meta ? 'agent_id'
     )
     SELECT se.event_id,
            se.parent_session_id,
            se.spawned_by_seq,
            se.agent_id,
            se.child_session_id,
            (child.id IS NOT NULL) AS child_exists,
            child.parent_session_id AS linked_parent_session_id,
            child.spawned_by_seq AS linked_spawned_by_seq
       FROM spawn_events se
       LEFT JOIN sessions child ON child.id = se.agent_id
      ORDER BY se.parent_session_id ASC, se.spawned_by_seq ASC`,
  );

  assertOk(spawns.length > 0, 'no Codex spawn_agent events with agent_id were ingested');

  const linkable = spawns.filter((row) => row.agent_id && row.child_exists);
  const unlinkable = spawns.filter((row) => row.agent_id && !row.child_exists);
  assertOk(linkable.length > 0, 'no linkable spawn_agent events found');

  for (const row of linkable) {
    assertOk(
      row.child_session_id === row.agent_id,
      `launcher ${row.event_id} missing meta.child_session_id=${row.agent_id}`,
    );
    assertOk(
      row.linked_parent_session_id === row.parent_session_id,
      `child ${row.agent_id} parent_session_id=${row.linked_parent_session_id} expected ${row.parent_session_id}`,
    );
    assertOk(
      row.linked_spawned_by_seq === row.spawned_by_seq,
      `child ${row.agent_id} spawned_by_seq=${row.linked_spawned_by_seq} expected ${row.spawned_by_seq}`,
    );
  }

  for (const row of unlinkable) {
    assertOk(
      row.child_session_id == null,
      `launcher ${row.event_id} points at absent child ${row.agent_id} but has child_session_id=${row.child_session_id}`,
    );
  }

  const real = spawns.find(
    (row) => row.parent_session_id === REAL_PARENT && row.agent_id === REAL_CHILD,
  );
  assertOk(real, `real Codex pair missing: ${REAL_PARENT} -> ${REAL_CHILD}`);
  assertOk(real?.child_session_id === REAL_CHILD, `real Codex pair did not stamp meta.child_session_id=${REAL_CHILD}`);
  assertOk(real?.linked_parent_session_id === REAL_PARENT, `real Codex child did not link to parent ${REAL_PARENT}`);

  await verifyMissingChildIsNotFabricated();

  const danglingEvents = await queryRows<DanglingEventRow>(
    `SELECT e.id AS event_id,
            e.meta->>'child_session_id' AS child_session_id
       FROM transcript_events e
       LEFT JOIN sessions child ON child.id = e.meta->>'child_session_id'
      WHERE e.type = 'subagent'
        AND e.meta ? 'child_session_id'
        AND child.id IS NULL`,
  );
  assertOk(danglingEvents.length === 0, `dangling child_session_id events: ${danglingEvents.length}`);

  const fabricatedSessions = await queryRows<FabricatedSessionRow>(
    `SELECT child.id, child.parent_session_id, child.spawned_by_seq
       FROM sessions child
       LEFT JOIN transcript_events launcher
         ON launcher.session_id = child.parent_session_id
        AND launcher.seq = child.spawned_by_seq
        AND launcher.type = 'subagent'
        AND launcher.meta->>'child_session_id' = child.id
      WHERE child.parent_session_id IS NOT NULL
        AND launcher.id IS NULL`,
  );
  assertOk(fabricatedSessions.length === 0, `fabricated parent_session_id links: ${fabricatedSessions.length}`);

  const direct = (
    await queryRows<TotalsRow>(
      `SELECT COUNT(*)::int AS sessions,
              COALESCE(SUM(token_usage), 0)::int AS tokens,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost
         FROM sessions`,
    )
  )[0];
  const stats = await getStats();
  assertOk(stats.totals.sessions === direct.sessions, `stats sessions ${stats.totals.sessions} != direct ${direct.sessions}`);
  assertOk(stats.totals.tokens === direct.tokens, `stats tokens ${stats.totals.tokens} != direct ${direct.tokens}`);
  assertOk(Math.abs(stats.totals.cost - direct.cost) < 0.000001, `stats cost ${stats.totals.cost} != direct ${direct.cost}`);

  console.log('================ Lathe sub-agent link verification ================');
  console.log(`spawn_agent events : ${spawns.length}`);
  console.log(`linkable          : ${linkable.length}`);
  console.log(`unlinkable        : ${unlinkable.length}`);
  console.log('missing fixture   : not fabricated');
  console.log(`linked child rows : ${linkable.filter((row) => row.linked_parent_session_id).length}`);
  console.log(`stats totals      : sessions=${direct.sessions} tokens=${direct.tokens} cost=${direct.cost.toFixed(6)}`);
  console.log('===================================================================');
  console.log('VERDICT: GREEN — sub-agent session links are real, non-fabricated, and stats totals stay session-based.');
}

main()
  .catch((error) => {
    console.error(`[verify-subagents] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
