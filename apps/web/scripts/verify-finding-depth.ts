import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { closePool, DEFAULT_DATABASE_URL, getPool } from '../lib/postgres';
import { backfillFindingAnalysis, runAnalyst, runAnalystSmoke } from './analyst-engine';

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');
const KNOWN_INCIDENTS_PATH = path.resolve(process.cwd(), '..', '..', 'spec', 'known-incidents.json');
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

function fail(message: string): never {
  throw new Error(message);
}

function scratchDatabaseUrl(schema: string): string {
  const url = new URL(ORIGINAL_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

async function withScratch<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  const schema = `${prefix}_${process.pid}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Pool({ connectionString: ORIGINAL_DATABASE_URL });
  const previousDatabaseUrl = process.env.DATABASE_URL;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await closePool();
  process.env.DATABASE_URL = scratchDatabaseUrl(schema);
  try {
    return await fn();
  } finally {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function applySchema(): Promise<void> {
  await getPool().query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

async function assertDepthColumns(label: string): Promise<void> {
  const columns = await getPool().query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'findings'
        AND column_name IN ('analysis', 'backlog_status', 'backlog_actor')
      ORDER BY column_name`,
  );
  const found = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));
  if (found.get('analysis') !== 'jsonb') fail(`${label}: findings.analysis is not jsonb`);
  if (found.get('backlog_status') !== 'text') fail(`${label}: findings.backlog_status is not text`);
  if (found.get('backlog_actor') !== 'text') fail(`${label}: findings.backlog_actor is not text`);

  const checks = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM pg_constraint
      WHERE conrelid = 'findings'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%backlog_status%'
        AND pg_get_constraintdef(oid) LIKE '%addressed%'
        AND pg_get_constraintdef(oid) LIKE '%dismissed%'`,
  );
  if ((checks.rows[0]?.n ?? 0) < 1) fail(`${label}: backlog_status CHECK constraint missing`);
}

async function verifyFreshMigration(): Promise<void> {
  await withScratch('finding_depth_fresh', async () => {
    await applySchema();
    await assertDepthColumns('fresh first apply');
    await applySchema();
    await assertDepthColumns('fresh second apply');
  });
}

async function verifyExistingMigration(): Promise<void> {
  await withScratch('finding_depth_existing', async () => {
    await getPool().query(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL
      );
      CREATE TABLE harness_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        provider TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE findings (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        analyst TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('failure_loop', 'unattributed_diff', 'excess_cost', 'risky_action')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        harness_version_id TEXT REFERENCES harness_versions(id) ON DELETE SET NULL,
        project_id TEXT NOT NULL REFERENCES projects(id)
      );
    `);
    await applySchema();
    await assertDepthColumns('existing first alter');
    await applySchema();
    await assertDepthColumns('existing second alter');

    let rejected = false;
    try {
      await getPool().query(
        `INSERT INTO projects (id,display_name) VALUES ('depth-existing','Depth Existing');
         INSERT INTO findings (analyst,kind,title,body,confidence,project_id,backlog_status)
         VALUES ('rules-v1','failure_loop','bad backlog','bad backlog',0.5,'depth-existing','invalid');`,
      );
    } catch {
      rejected = true;
    }
    if (!rejected) fail('existing alter did not enforce backlog_status CHECK');
  });
}

async function seedAnalystSession(): Promise<string> {
  const sessionId = 'finding-depth-analyst-session';
  await getPool().query(
    `INSERT INTO projects (id,display_name)
     VALUES ('finding-depth-project','Finding Depth Project')`,
  );
  await getPool().query(
    `INSERT INTO sessions (
       id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
       edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
       cost_usd,summary,seq
     )
     VALUES ($1,'finding-depth-project','Finding Depth Project','Depth smoke repeated pnpm test','codex','gpt-5.5','failed',
       '2026-06-13 00:00:00','2026-06-13 00:00:10',10000,1,3,0,3,0,3,100,60,40,
       'loop/21-finding-depth',0,0.02,'depth smoke',1)`,
    [sessionId],
  );
  await getPool().query(
    `INSERT INTO transcript_events
      (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
     VALUES
      ($1,$2,1,'00:00:00','user_message','user','Depth prompt','Please stabilize finding-depth smoke.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      ($3,$2,2,'00:00:01','bash','assistant','Depth failed command','exit 1: fixture depth failure',NULL,'pnpm test -- --grep=finding-depth',1,1200,30,NULL,NULL,NULL),
      ($4,$2,3,'00:00:02','bash','assistant','Depth failed command','exit 1: fixture depth failure',NULL,'pnpm test -- --grep=finding-depth',1,1200,30,NULL,NULL,NULL),
      ($5,$2,4,'00:00:03','bash','assistant','Depth failed command','exit 1: fixture depth failure',NULL,'pnpm test -- --grep=finding-depth',1,1200,30,NULL,NULL,NULL)`,
    [
      `${sessionId}-event-1`,
      sessionId,
      `${sessionId}-event-2`,
      `${sessionId}-event-3`,
      `${sessionId}-event-4`,
    ],
  );
  return sessionId;
}

async function verifyAnalystAnalysis(): Promise<void> {
  await withScratch('finding_depth_analyst', async () => {
    await applySchema();
    const sessionId = await seedAnalystSession();
    const result = await runAnalyst({ candidate: 'rules-v1', sessionId, source: 'smoke' });
    if (result.created < 1) fail(`rules-v1 did not create a scratch finding: ${JSON.stringify(result)}`);

    const row = (await getPool().query<{ analysis: string | null }>(
      `SELECT analysis::text AS analysis
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = 'rules-v1'
          AND fe.session_id = $1
        ORDER BY f.id ASC
        LIMIT 1`,
      [sessionId],
    )).rows[0] ?? fail('scratch analyst finding missing');
    const analysis = row.analysis ? JSON.parse(row.analysis) as Record<string, unknown> : fail('scratch analyst analysis missing');
    const text = Object.values(analysis).filter((value): value is string => typeof value === 'string').join(' ');
    const nonNull = Object.values(analysis).filter((value) => typeof value === 'string' && value.trim()).length;
    if (nonNull < 2) fail(`scratch analyst analysis has too few fields: ${row.analysis}`);
    if (!text.includes('pnpm test -- --grep=finding-depth')) {
      fail(`scratch analyst analysis is not grounded in the evidence command: ${row.analysis}`);
    }
    if (!text.includes('Please stabilize finding-depth smoke')) {
      fail(`scratch analyst analysis is not grounded in USER ASKED context: ${row.analysis}`);
    }
  });
}

function knownIncidentSessionIds(): string[] {
  const parsed = JSON.parse(fs.readFileSync(KNOWN_INCIDENTS_PATH, 'utf8')) as {
    incidents?: Array<{ session_id?: string }>;
  };
  return [...new Set((parsed.incidents ?? []).map((incident) => incident.session_id).filter((id): id is string => Boolean(id)))];
}

async function verifyKnownIncidentSmoke(): Promise<void> {
  await withScratch('finding_depth_known', async () => {
    await applySchema();
    const sessionIds = knownIncidentSessionIds();
    if (!sessionIds.length) fail('known incident fixture file has no session ids');

    await getPool().query(
      `INSERT INTO projects (id, display_name, git_remote, cwd_hint, created_at, updated_at)
       SELECT id, display_name, git_remote, cwd_hint, created_at, updated_at
         FROM public.projects
       ON CONFLICT DO NOTHING`,
    );
    await getPool().query(
      `INSERT INTO harness_versions (id, project_id, provider, content_hash, captured_at, git_commit)
       SELECT id, project_id, provider, content_hash, captured_at, git_commit
         FROM public.harness_versions
       ON CONFLICT DO NOTHING`,
    );
    await getPool().query(
      `INSERT INTO sessions (
         id, project_id, project, title, runner, model, status, started_at, ended_at,
         duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
         error_count, token_usage, token_in, token_out, git_branch, commit_count,
         cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq
       )
       SELECT id, project_id, project, title, runner, model, status, started_at, ended_at,
              duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
              error_count, token_usage, token_in, token_out, git_branch, commit_count,
              cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq
         FROM public.sessions
       ON CONFLICT DO NOTHING`,
    );
    await getPool().query(
      `INSERT INTO transcript_events (
         id, session_id, seq, ts, type, actor, title, body, file_path, command,
         exit_code, duration_ms, token_usage, subagent, meta, parent_id
       )
       SELECT id, session_id, seq, ts, type, actor, title, body, file_path, command,
              exit_code, duration_ms, token_usage, subagent, meta, parent_id
         FROM public.transcript_events
        WHERE session_id = ANY($1::text[])
       ON CONFLICT DO NOTHING`,
      [sessionIds],
    );

    const result = await runAnalystSmoke();
    if (!result.recall.some((item) => item.found === item.total)) {
      fail(`known incident smoke had no full-recall candidate: ${JSON.stringify(result.recall)}`);
    }
    console.log(`[verify-finding-depth:known] recall=${result.recall.map((item) => `${item.candidate}:${item.found}/${item.total}${item.skipped ? ':skip' : ''}`).join(' ')}`);
  });
}

async function verifyExistingFindingBackfill(): Promise<void> {
  await withScratch('finding_depth_backfill', async () => {
    await applySchema();
    const ids = [110, 111, 112, 113, 114];

    await getPool().query(
      `INSERT INTO projects (id, display_name, git_remote, cwd_hint, created_at, updated_at)
       SELECT id, display_name, git_remote, cwd_hint, created_at, updated_at
         FROM public.projects
       ON CONFLICT DO NOTHING`,
    );
    await getPool().query(
      `INSERT INTO harness_versions (id, project_id, provider, content_hash, captured_at, git_commit)
       SELECT id, project_id, provider, content_hash, captured_at, git_commit
         FROM public.harness_versions
       ON CONFLICT DO NOTHING`,
    );
    await getPool().query(
      `INSERT INTO sessions (
         id, project_id, project, title, runner, model, status, started_at, ended_at,
         duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
         error_count, token_usage, token_in, token_out, git_branch, commit_count,
         cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq
       )
       SELECT id, project_id, project, title, runner, model, status, started_at, ended_at,
              duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
              error_count, token_usage, token_in, token_out, git_branch, commit_count,
              cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq
         FROM public.sessions
        WHERE id IN (
          SELECT DISTINCT session_id
            FROM public.finding_evidence
           WHERE finding_id = ANY($1::int[])
             AND session_id IS NOT NULL
        )
       ON CONFLICT DO NOTHING`,
      [ids],
    );
    await getPool().query(
      `INSERT INTO transcript_events (
         id, session_id, seq, ts, type, actor, title, body, file_path, command,
         exit_code, duration_ms, token_usage, subagent, meta, parent_id
       )
       SELECT id, session_id, seq, ts, type, actor, title, body, file_path, command,
              exit_code, duration_ms, token_usage, subagent, meta, parent_id
         FROM public.transcript_events
        WHERE session_id IN (
          SELECT DISTINCT session_id
            FROM public.finding_evidence
           WHERE finding_id = ANY($1::int[])
             AND session_id IS NOT NULL
        )
       ON CONFLICT DO NOTHING`,
      [ids],
    );
    await getPool().query(
      `INSERT INTO findings (
         id, created_at, analyst, kind, title, body, confidence, harness_version_id,
         project_id, analysis, backlog_status, backlog_actor
       )
       OVERRIDING SYSTEM VALUE
       SELECT id, created_at, analyst, kind, title, body, confidence, harness_version_id,
              project_id, NULL::jsonb AS analysis, backlog_status, NULL::text AS backlog_actor
         FROM public.findings
        WHERE id = ANY($1::int[])
       ON CONFLICT DO NOTHING`,
      [ids],
    );
    await getPool().query(
      `INSERT INTO finding_evidence (finding_id, subject_kind, session_id, locator, subject_id, note)
       SELECT finding_id, subject_kind, session_id, locator, subject_id, note
         FROM public.finding_evidence
        WHERE finding_id = ANY($1::int[])`,
      [ids],
    );

    const result = await backfillFindingAnalysis(ids);
    if (result.considered !== ids.length || result.updated !== ids.length || result.skipped !== 0) {
      fail(`existing finding backfill did not regenerate #110-114: ${JSON.stringify(result)}`);
    }
    const missing = await getPool().query<{ id: number }>(
      `SELECT id
         FROM findings
        WHERE id = ANY($1::int[])
          AND (
            analysis IS NULL
            OR jsonb_typeof(analysis) <> 'object'
            OR (
              COALESCE(NULLIF(analysis->>'cause_hypothesis', ''), NULLIF(analysis->>'agent_intent', ''), NULLIF(analysis->>'impact', '')) IS NULL
            )
          )
        ORDER BY id`,
      [ids],
    );
    if (missing.rows.length) fail(`existing finding backfill left analysis empty: ${missing.rows.map((row) => row.id).join(', ')}`);
    const regenerated = await getPool().query<{ id: number; text: string }>(
      `SELECT id,
              concat_ws(' ',
                analysis->>'cause_hypothesis',
                analysis->>'agent_intent',
                analysis->>'impact'
              ) AS text
         FROM findings
        WHERE id = ANY($1::int[])
        ORDER BY id ASC`,
      [ids],
    );
    const required: Record<number, RegExp[]> = {
      110: [/gh issue view/i, /Projects classic|projectCards|sunset/i],
      111: [/git diff --check/i, /whitespace|exit 2/i],
      112: [/No such file|cwd|path/i, /line range|nonexistent file|missing file/i],
      113: [/rg|ripgrep/i, /exit 1/i, /no matches|no-match/i],
      114: [/AivisSpeech|EADDRINUSE|occupied port|local port/i, /BERT|user-dictionary|runtime service|runtime process|environment setup/i],
    };
    for (const row of regenerated.rows) {
      const misses = (required[row.id] ?? []).filter((pattern) => !pattern.test(row.text));
      if (misses.length) fail(`existing finding #${row.id} backfill analysis is not deep enough: ${row.text}`);
    }
  });
}

async function main(): Promise<void> {
  await verifyFreshMigration();
  await verifyExistingMigration();
  await verifyAnalystAnalysis();
  await verifyKnownIncidentSmoke();
  await verifyExistingFindingBackfill();
  console.log('[verify-finding-depth] GREEN fresh_schema=true existing_alter=true analyst_analysis=grounded');
}

main()
  .catch((error) => {
    console.error(`[verify-finding-depth] failed: ${(error as Error).stack ?? (error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
