import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { closePool, getPool, queryRows } from '../lib/postgres';
import { getStats } from '../lib/db';
import { insertBuilt } from './ingest/db';
import type { Built } from './ingest/built';
import { currentDatabaseUrl, withScratchDatabase } from './verify/scratch';

// Issue #11: this verifier used to insert/delete its fixtures through the
// shared DB (whatever search_path DATABASE_URL resolved to), so a caller that
// forgot to pass a scratch search_path would write into the live `lathe`
// schema and race a concurrent full ingest (tasks/19 L56-58, tasks/14). It is
// now self-contained: it CREATEs a dedicated scratch schema, applies the
// schema, seeds its own fixtures, asserts, and DROPs the schema CASCADE — never
// depending on the DATABASE_URL search_path and never touching shared rows.

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');

// A linkable parent/child pair we seed ourselves so the spawn→child link
// assertions have real data without a cloud transcript. The maintainer
// re-verifies the spawn→link integrity over real ingested data separately.
const LINK_FIXTURE_PROJECT = 'fixture:verify-subagent-linkable';
const LINK_FIXTURE_PARENT = 'fixture-verify-subagent-linkable-parent';
const LINK_FIXTURE_CHILD = 'fixture-verify-subagent-linkable-child';
const LINK_FIXTURE_SPAWN_SEQ = 2;

// A spawn whose child agent_id is absent from the DB — must never be fabricated
// into a parent_session_id link.
const MISSING_FIXTURE_PROJECT = 'fixture:verify-subagent-missing-child';
const MISSING_FIXTURE_PARENT = 'fixture-verify-subagent-missing-parent';
const MISSING_FIXTURE_AGENT = 'fixture-verify-subagent-absent-child';

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

function assertOk(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

// Count rows in the SHARED schema (unmodified DATABASE_URL) so we can prove the
// verifier left no side-effects there. Returns null when the shared schema has
// not been initialised (e.g. no `lathe` tables yet), in which case there is
// nothing that could have been polluted.
async function sharedRowCounts(): Promise<Record<string, number> | null> {
  const admin = new Pool({ connectionString: currentDatabaseUrl() });
  try {
    const tables = ['projects', 'sessions', 'transcript_events'];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const result = await admin.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      counts[table] = result.rows[0]?.n ?? 0;
    }
    return counts;
  } catch {
    return null;
  } finally {
    await admin.end();
  }
}

function baseSession(id: string, projectId: string, project: string, title: string): Built['session'] {
  return {
    id,
    projectId,
    project,
    projectGitRemote: null,
    projectCwdHint: null,
    title,
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
  };
}

function emptyBuilt(session: Built['session'], events: Built['events']): Built {
  return {
    session,
    events,
    sessionCommits: [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

// Parent whose spawn_agent event references a child that DOES exist in this
// batch → linkSubagentSessions must stamp meta.child_session_id and set the
// child's parent_session_id / spawned_by_seq.
function linkableParentBuilt(): Built {
  const session = baseSession(
    LINK_FIXTURE_PARENT,
    LINK_FIXTURE_PROJECT,
    'Verify Sub-agent Linkable',
    'Verify linkable child is linked',
  );
  session.seq = 999997;
  return emptyBuilt(session, [
    {
      id: `${LINK_FIXTURE_PARENT}_1`,
      session_id: LINK_FIXTURE_PARENT,
      seq: 1,
      ts: '00:00:00',
      type: 'user_message',
      actor: 'user',
      title: 'verify linkable child',
      body: 'verify linkable child',
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
      id: `${LINK_FIXTURE_PARENT}_2`,
      session_id: LINK_FIXTURE_PARENT,
      seq: LINK_FIXTURE_SPAWN_SEQ,
      ts: '00:00:01',
      type: 'subagent',
      actor: 'assistant',
      title: 'Sub-agent · explorer',
      body: 'linkable child fixture',
      file_path: null,
      command: null,
      exit_code: null,
      duration_ms: null,
      token_usage: null,
      subagent: 'explorer',
      meta: JSON.stringify({ tool: 'spawn_agent', agent_id: LINK_FIXTURE_CHILD }),
      parent_id: null,
    },
  ]);
}

// The child session referenced by the linkable parent above.
function linkableChildBuilt(): Built {
  const session = baseSession(
    LINK_FIXTURE_CHILD,
    LINK_FIXTURE_PROJECT,
    'Verify Sub-agent Linkable Child',
    'Linkable child session',
  );
  session.seq = 999998;
  session.subagent_count = 0;
  return emptyBuilt(session, [
    {
      id: `${LINK_FIXTURE_CHILD}_1`,
      session_id: LINK_FIXTURE_CHILD,
      seq: 1,
      ts: '00:00:00',
      type: 'user_message',
      actor: 'user',
      title: 'child work',
      body: 'child work',
      file_path: null,
      command: null,
      exit_code: null,
      duration_ms: null,
      token_usage: null,
      subagent: null,
      meta: null,
      parent_id: null,
    },
  ]);
}

// Parent whose spawn_agent event references a child that is NOT ingested →
// linkSubagentSessions must NOT fabricate a link or stamp child_session_id.
function missingChildBuilt(): Built {
  const session = baseSession(
    MISSING_FIXTURE_PARENT,
    MISSING_FIXTURE_PROJECT,
    'Verify Sub-agent Missing Child',
    'Verify missing child is not fabricated',
  );
  return emptyBuilt(session, [
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
  ]);
}

async function applySchema(): Promise<void> {
  await getPool().query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

// The missing-child specific assertions (preserved from the original
// verifyMissingChildIsNotFabricated): the launcher event keeps no
// child_session_id and no child session row is fabricated.
async function assertMissingChildNotFabricated(): Promise<void> {
  const pool = getPool();
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
}

async function verify(): Promise<void> {
  await applySchema();

  // Seed every fixture in one batch so insertBuilt's real linkSubagentSessions
  // logic runs exactly as it does during ingest.
  await insertBuilt(
    getPool(),
    [linkableParentBuilt(), linkableChildBuilt(), missingChildBuilt()],
    { backfillHarness: false },
  );

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

  assertOk(spawns.length > 0, 'no Codex spawn_agent events with agent_id were seeded');

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

  // The seeded linkable pair stands in for the real Codex pair the original
  // verifier asserted against (REAL_PARENT -> REAL_CHILD): a specific, known
  // parent/child must be stamped and linked.
  const seeded = spawns.find(
    (row) => row.parent_session_id === LINK_FIXTURE_PARENT && row.agent_id === LINK_FIXTURE_CHILD,
  );
  assertOk(seeded, `seeded linkable pair missing: ${LINK_FIXTURE_PARENT} -> ${LINK_FIXTURE_CHILD}`);
  assertOk(
    seeded?.child_session_id === LINK_FIXTURE_CHILD,
    `seeded linkable pair did not stamp meta.child_session_id=${LINK_FIXTURE_CHILD}`,
  );
  assertOk(
    seeded?.linked_parent_session_id === LINK_FIXTURE_PARENT,
    `seeded linkable child did not link to parent ${LINK_FIXTURE_PARENT}`,
  );
  assertOk(
    seeded?.linked_spawned_by_seq === LINK_FIXTURE_SPAWN_SEQ,
    `seeded linkable child spawned_by_seq=${seeded?.linked_spawned_by_seq} expected ${LINK_FIXTURE_SPAWN_SEQ}`,
  );

  await assertMissingChildNotFabricated();

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
  console.log('NOTE: verified in an isolated scratch schema with self-seeded fixtures; no shared-DB rows were read or written.');
}

async function main(): Promise<void> {
  // Prove the verifier leaves the shared schema untouched: snapshot its row
  // counts before and after the scratch-bound run and assert they are unchanged.
  const before = await sharedRowCounts();
  await withScratchDatabase('lathe_verifysub', verify);
  const after = await sharedRowCounts();

  if (before && after) {
    for (const table of Object.keys(before)) {
      assertOk(
        before[table] === after[table],
        `shared schema mutated: ${table} ${before[table]} -> ${after[table]}`,
      );
    }
    console.log(
      `shared schema side-effect check: unchanged (sessions=${after.sessions}, transcript_events=${after.transcript_events})`,
    );
  } else {
    console.log('shared schema side-effect check: skipped (shared schema not initialised)');
  }
}

main()
  .catch((error) => {
    console.error(`[verify-subagents] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
