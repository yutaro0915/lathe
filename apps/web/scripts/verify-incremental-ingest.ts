/**
 * Integration test for incremental ingest invariants.
 *
 * Runs against a scratch schema inside the scratch DB (55433).
 * Call via:
 *   DATABASE_URL=postgres://lathe:lathe@localhost:55433/lathe \
 *   pnpm -C apps/web run verify:incremental
 *
 * Invariants tested:
 *  1. no-wipe / 複数 project 共存
 *       project A full ingest → project B incremental → A session count unchanged
 *  2. findings 非孤立
 *       A finding + evidence referencing A session survives B incremental ingest
 *  3. 冪等 — same dir ingested twice incremental → session/event counts identical
 *  4. FK 整合 — no dangling FK (transcript_events / changed_files / diff_hunks)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Pool } from 'pg';
import { insertBuilt } from './ingest/repository/ingest-writer';
import { runIncrementalIngest } from './ingest/usecase/incremental';
import type { Built } from './ingest/built';
import { withScratchDatabase } from './verify/scratch';

// ---------------------------------------------------------------------------
// VERDICT helpers
// ---------------------------------------------------------------------------

const verdicts: Array<{ label: string; pass: boolean; detail: string }> = [];

function verdict(label: string, pass: boolean, detail: string): void {
  verdicts.push({ label, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}`);
  if (!pass) console.log(`       ${detail}`);
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const PROJECT_A = 'fixture:incremental-A';
const PROJECT_B = 'fixture:incremental-B';

function baseSession(id: string, projectId: string, overrides: Partial<Built['session']> = {}): Built['session'] {
  return {
    id,
    projectId,
    project: projectId,
    projectGitRemote: null,
    projectCwdHint: null,
    title: id,
    runner: 'codex',
    model: 'gpt-test',
    status: 'done',
    started_at: '2026-06-26 00:00:00',
    ended_at: '2026-06-26 00:00:01',
    duration_ms: 1000,
    turn_count: 1,
    tool_count: 0,
    edit_count: 0,
    bash_count: 0,
    subagent_count: 0,
    error_count: 0,
    token_usage: 100,
    token_in: 50,
    token_out: 50,
    git_branch: 'main',
    commit_count: 0,
    cost_usd: null,
    summary: null,
    harness_version_id: null,
    parent_session_id: null,
    spawned_by_seq: null,
    seq: 1,
    session_class: 'development',
    _startMs: 0,
    ...overrides,
  };
}

function minimalEvent(id: string, sessionId: string, seq: number): Built['events'][number] {
  return {
    id,
    session_id: sessionId,
    seq,
    ts: '00:00:00',
    type: 'user_message',
    actor: 'user',
    title: 'hello',
    body: 'hello',
    file_path: null,
    command: null,
    exit_code: null,
    duration_ms: null,
    token_usage: null,
    subagent: null,
    meta: null,
    parent_id: null,
  };
}

function makeBuilt(sessionId: string, projectId: string, seqOffset = 0): Built {
  return {
    session: baseSession(sessionId, projectId, { seq: seqOffset + 1 }),
    events: [minimalEvent(`${sessionId}_e1`, sessionId, 1)],
    sessionCommits: [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

// ---------------------------------------------------------------------------
// Fake transcript dir for incremental ingest
// ---------------------------------------------------------------------------

/**
 * Write a single fake .jsonl transcript file so runIncrementalIngest can
 * process it via buildClaudeSession.
 */
function writeFakeTranscriptDir(tmpDir: string, sessionId: string): string {
  const dir = path.join(tmpDir, `fake-${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  // Minimal Claude Code transcript: sessionId record + user message + assistant
  const records = [
    JSON.stringify({ sessionId, timestamp: '2026-06-26T00:00:00Z', cwd: '/tmp/fake' }),
    JSON.stringify({
      type: 'user',
      message: { content: 'hello incremental' },
      timestamp: '2026-06-26T00:00:00Z',
      sessionId,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
      timestamp: '2026-06-26T00:00:01Z',
      sessionId,
    }),
  ];
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, records.join('\n') + '\n');
  return dir;
}

// ---------------------------------------------------------------------------
// Dangling FK check
// ---------------------------------------------------------------------------

async function danglingFkCount(pool: Pool): Promise<number> {
  const res = await pool.query<{ n: string }>(`
    SELECT (
      SELECT COUNT(*) FROM transcript_events e
       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)
    ) + (
      SELECT COUNT(*) FROM changed_files f
       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id)
    ) + (
      SELECT COUNT(*) FROM diff_hunks h
       WHERE NOT EXISTS (SELECT 1 FROM changed_files f WHERE f.id = h.file_id)
    ) AS n
  `);
  return Number(res.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-incr-'));

  try {
    await withScratchDatabase('incr_test', async ({ createPool }) => {
      const pool = createPool();

      try {
        await pool.query(schemaSql);

        // ------------------------------------------------------------------
        // Invariant 1: no-wipe / 複数 project 共存
        // ------------------------------------------------------------------
        //   A: 3 sessions full ingest
        //   B: 1 session incremental ingest
        //   → A session count must stay at 3
        const aBuilt1 = makeBuilt('a-session-001', PROJECT_A, 1);
        const aBuilt2 = makeBuilt('a-session-002', PROJECT_A, 2);
        const aBuilt3 = makeBuilt('a-session-003', PROJECT_A, 3);

        await insertBuilt(pool, [aBuilt1, aBuilt2, aBuilt3], { backfillHarness: false });

        const aCountBefore = (
          await pool.query<{ c: string }>(`SELECT COUNT(*) AS c FROM sessions WHERE project_id = $1`, [PROJECT_A])
        ).rows[0].c;

        // Incremental ingest of project B using fake transcript dir
        const bDirPath = writeFakeTranscriptDir(tmpDir, 'b-session-001');
        await runIncrementalIngest(pool, {
          dirs: [{ dir: bDirPath, latestMtimeMs: Date.now(), latestIngestableMtimeMs: Date.now() }],
          insertOpts: { backfillHarness: false },
          codexRolloutFiles: [],
        });

        const aCountAfter = (
          await pool.query<{ c: string }>(`SELECT COUNT(*) AS c FROM sessions WHERE project_id = $1`, [PROJECT_A])
        ).rows[0].c;

        verdict(
          'no-wipe / 複数 project 共存',
          aCountBefore === aCountAfter,
          `A count before=${aCountBefore}, after=${aCountAfter}`,
        );

        // ------------------------------------------------------------------
        // Invariant 2: findings 非孤立
        // ------------------------------------------------------------------
        //   Insert a finding linked to PROJECT_A (via project_id) and evidence
        //   pointing to a-session-001 (via session_id logical coordinate).
        //   Then run B incremental → finding + evidence + a-session-001 must survive.
        const findingInsert = await pool.query<{ id: number }>(
          `INSERT INTO findings
             (analyst, kind, title, body, confidence, project_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          ['test-analyst', 'excess_cost', 'test finding', 'body', 0.9, PROJECT_A],
        );
        const findingId = findingInsert.rows[0].id;

        await pool.query(
          `INSERT INTO finding_evidence
             (finding_id, subject_kind, session_id, locator)
           VALUES ($1, $2, $3, $4)`,
          [findingId, 'session', 'a-session-001', '{}'],
        );

        // Re-run B incremental (idempotent)
        await runIncrementalIngest(pool, {
          dirs: [{ dir: bDirPath, latestMtimeMs: Date.now(), latestIngestableMtimeMs: Date.now() }],
          insertOpts: { backfillHarness: false },
          codexRolloutFiles: [],
        });

        const findingRow = await pool.query<{ id: number }>(
          `SELECT id FROM findings WHERE id = $1`,
          [findingId],
        );
        const evidenceRow = await pool.query<{ session_id: string }>(
          `SELECT session_id FROM finding_evidence WHERE finding_id = $1`,
          [findingId],
        );
        const aSessionExists =
          (await pool.query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, ['a-session-001'])).rows.length > 0;

        verdict(
          'findings 非孤立',
          findingRow.rows.length > 0 && evidenceRow.rows.length > 0 && aSessionExists,
          `finding exists=${findingRow.rows.length > 0}, evidence rows=${evidenceRow.rows.length}, a-session exists=${aSessionExists}`,
        );

        // ------------------------------------------------------------------
        // Invariant 3: 冪等
        // ------------------------------------------------------------------
        //   Same dir ingested twice → session/event counts for that project identical.
        //   COUNT is scoped to project_id so other fixture sessions don't bleed in.

        const cDirPath = writeFakeTranscriptDir(tmpDir, 'c-session-001');
        // writeFakeTranscriptDir uses cwd='/tmp/fake', so project_id = 'local:/tmp/fake'
        const C_PROJECT_ID = 'local:/tmp/fake';
        const incrOpts = {
          dirs: [{ dir: cDirPath, latestMtimeMs: Date.now(), latestIngestableMtimeMs: Date.now() }],
          insertOpts: { backfillHarness: false },
          codexRolloutFiles: [],
        };

        await runIncrementalIngest(pool, incrOpts);
        const sessCount1 = (
          await pool.query<{ c: string }>(
            `SELECT COUNT(*) AS c FROM sessions WHERE project_id = $1`,
            [C_PROJECT_ID],
          )
        ).rows[0].c;
        const evtCount1 = (
          await pool.query<{ c: string }>(
            `SELECT COUNT(*) AS c FROM transcript_events
              WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
            [C_PROJECT_ID],
          )
        ).rows[0].c;

        // Force re-ingest by making ended_at look old
        await pool.query(
          `UPDATE sessions SET ended_at = '2020-01-01 00:00:00' WHERE id = 'c-session-001'`,
        );

        await runIncrementalIngest(pool, {
          ...incrOpts,
          dirs: [{ dir: cDirPath, latestMtimeMs: Date.now(), latestIngestableMtimeMs: Date.now() }],
        });
        const sessCount2 = (
          await pool.query<{ c: string }>(
            `SELECT COUNT(*) AS c FROM sessions WHERE project_id = $1`,
            [C_PROJECT_ID],
          )
        ).rows[0].c;
        const evtCount2 = (
          await pool.query<{ c: string }>(
            `SELECT COUNT(*) AS c FROM transcript_events
              WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
            [C_PROJECT_ID],
          )
        ).rows[0].c;

        verdict(
          '冪等',
          sessCount1 === sessCount2 && evtCount1 === evtCount2,
          `sessions: ${sessCount1} vs ${sessCount2}, events: ${evtCount1} vs ${evtCount2}`,
        );

        // ------------------------------------------------------------------
        // Invariant 4: FK 整合
        // ------------------------------------------------------------------
        const dangling = await danglingFkCount(pool);
        verdict('FK 整合', dangling === 0, `dangling FK rows: ${dangling}`);

        // ------------------------------------------------------------------
        // Summary
        // ------------------------------------------------------------------
        console.log('');
        console.log('=== Incremental ingest verification summary ===');
        for (const v of verdicts) {
          console.log(`  [${v.pass ? 'PASS' : 'FAIL'}] ${v.label}${v.pass ? '' : ` — ${v.detail}`}`);
        }
        console.log('');
        const allPass = verdicts.every((v) => v.pass);
        if (allPass) {
          console.log('VERDICT: GREEN — all incremental ingest invariants hold.');
        } else {
          const failed = verdicts.filter((v) => !v.pass).map((v) => v.label).join(', ');
          console.log(`VERDICT: RED — failed: ${failed}`);
          process.exitCode = 1;
        }
      } finally {
        await pool.end().catch(() => undefined);
      }
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((err) => {
  console.error(`[verify-incremental-ingest] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
