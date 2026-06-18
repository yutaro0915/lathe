import * as fs from 'node:fs';
import * as path from 'node:path';
import { closePool, getPool } from '../lib/postgres';
import { assertAnalysisGrounded, backfillFindingAnalysis, runAnalyst, runAnalystSmoke } from './analyst-engine';
import { withScratchDatabase } from './verify/scratch';

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');
const KNOWN_INCIDENTS_PATH = path.resolve(process.cwd(), '..', '..', 'spec', 'known-incidents.json');
const FAKE_ACP_AGENT_PATH = path.resolve(process.cwd(), '..', '..', 'packages', 'acp-client', 'test', 'fixtures', 'fake-acp-agent.mjs');

function fail(message: string): never {
  throw new Error(message);
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
}

async function verifyFreshMigration(): Promise<void> {
  await withScratchDatabase('finding_depth_fresh', async () => {
    await applySchema();
    await assertDepthColumns('fresh first apply');
    await applySchema();
    await assertDepthColumns('fresh second apply');
  });
}

async function verifyExistingMigration(): Promise<void> {
  await withScratchDatabase('finding_depth_existing', async () => {
    await getPool().query(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
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
      await getPool().query(`
        INSERT INTO projects (id,display_name) VALUES ('depth-existing','Depth Existing');
        INSERT INTO findings (analyst,kind,title,body,confidence,project_id,backlog_status)
        VALUES ('rules-v1','failure_loop','bad backlog','bad backlog',0.5,'depth-existing','invalid');
      `);
    } catch {
      rejected = true;
    }
    if (!rejected) fail('existing alter did not enforce backlog_status CHECK');
  });
}

async function seedAnalystSession(): Promise<string> {
  const sessionId = 'finding-depth-analyst-session';
  await getPool().query(`INSERT INTO projects (id,display_name) VALUES ('finding-depth-project','Finding Depth Project')`);
  await getPool().query(
    `INSERT INTO sessions (
       id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
       edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
       cost_usd,summary,seq
     )
     VALUES ($1,'finding-depth-project','Finding Depth Project','Depth smoke repeated pnpm test','codex','gpt-5.5','failed',
       '2026-06-13 00:00:00','2026-06-13 00:00:10',10000,4,3,0,3,0,3,100,60,40,
       'loop/25-analyst-acp',0,0.02,'depth smoke',1)`,
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
    [`${sessionId}-event-1`, sessionId, `${sessionId}-event-2`, `${sessionId}-event-3`, `${sessionId}-event-4`],
  );
  return sessionId;
}

async function verifyRulesAnalysis(): Promise<void> {
  await withScratchDatabase('finding_depth_rules', async () => {
    await applySchema();
    const sessionId = await seedAnalystSession();
    const result = await runAnalyst({ candidate: 'rules-v1', sessionId, source: 'smoke' });
    if (result.created < 1) fail(`rules-v1 did not create a scratch finding: ${JSON.stringify(result)}`);
    await assertAnalysisGrounded([sessionId]);
  });
}

async function verifyGenericAnalysisRejected(): Promise<void> {
  await withScratchDatabase('finding_depth_generic', async () => {
    await applySchema();
    const sessionId = await seedAnalystSession();
    const inserted = await getPool().query<{ id: number }>(
      `INSERT INTO findings (analyst,kind,title,body,confidence,project_id,analysis)
       VALUES ('hybrid-v1','failure_loop','Injected generic analysis','Generic analysis injection should not pass.',0.9,'finding-depth-project',$1::jsonb)
       RETURNING id`,
      [{
        cause_hypothesis: 'The same failing evidence repeated and needs further investigation.',
        agent_intent: 'The user asked Please stabilize finding-depth smoke.',
        impact: 'This may indicate an issue.',
      }],
    );
    await getPool().query(
      `INSERT INTO finding_evidence (finding_id, subject_kind, session_id, locator, note)
       VALUES ($1, 'turn', $2, $3::jsonb, 'generic injection evidence')`,
      [inserted.rows[0]?.id, sessionId, { seq: 2 }],
    );
    let rejected = false;
    try {
      await assertAnalysisGrounded([sessionId]);
    } catch {
      rejected = true;
    }
    if (!rejected) fail('generic analysis injection was not rejected');
  });
}

async function seedCueRoutingSession(): Promise<string> {
  const sessionId = 'finding-depth-cue-routing-session';
  await getPool().query(`INSERT INTO projects (id,display_name) VALUES ('finding-depth-cue-routing','Finding Depth Cue Routing')`);
  await getPool().query(
    `INSERT INTO sessions (
       id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
       edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
       cost_usd,summary,seq
     )
     VALUES ($1,'finding-depth-cue-routing','Finding Depth Cue Routing','Cue routing smoke','codex','gpt-5.5','failed',
       '2026-06-13 00:00:00','2026-06-13 00:00:10',10000,5,4,0,4,0,4,100,60,40,
       'loop/25-analyst-acp',0,0.02,'cue routing smoke',1)`,
    [sessionId],
  );
  await getPool().query(
    `INSERT INTO transcript_events
      (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
     VALUES
      ($1,$2,1,'00:00:00','user_message','user','Cue prompt','Please classify these command failures while データ依存 rg noise exists elsewhere in the session.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      ($3,$2,2,'00:00:01','bash','assistant','Ripgrep no match','',NULL,'rg unreachable-needle apps/web/scripts/analyst-engine.ts',1,1200,30,NULL,NULL,NULL),
      ($4,$2,3,'00:00:02','bash','assistant','GitHub issue comments failed','GraphQL: Projects classic is sunset; field projectCards does not exist.',NULL,'gh issue view 123 --comments',1,1200,30,NULL,NULL,NULL),
      ($5,$2,4,'00:00:03','bash','assistant','Sed missing file','sed: docs/missing.md: No such file or directory',NULL,'sed -n ''1,40p'' docs/missing.md',1,1200,30,NULL,NULL,NULL)`,
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

async function analysisCauseForTurn(sessionId: string, seq: number): Promise<string> {
  const result = await runAnalyst({ candidate: 'rules-v1', turn: { sessionId, seq }, source: 'smoke' });
  const id = result.findings.find((item) => item.findingId)?.findingId;
  if (!id) fail(`cue routing turn ${seq} did not create a finding: ${JSON.stringify(result)}`);
  const row = await getPool().query<{ cause: string | null }>(
    `SELECT analysis->>'cause_hypothesis' AS cause FROM findings WHERE id = $1`,
    [id],
  );
  return row.rows[0]?.cause ?? '';
}

async function verifyCueRouting(): Promise<void> {
  await withScratchDatabase('finding_depth_cue_routing', async () => {
    await applySchema();
    const sessionId = await seedCueRoutingSession();
    const rgCause = await analysisCauseForTurn(sessionId, 2);
    if (!/ripgrep/i.test(rgCause) || !/no matches/i.test(rgCause)) fail(`rg exit1 did not route to ripgrep no-match analysis: ${rgCause}`);
    const ghCause = await analysisCauseForTurn(sessionId, 3);
    if (!/Projects classic/i.test(ghCause) || /ripgrep/i.test(ghCause)) fail(`gh projectCards failure did not route to GitHub Projects classic analysis: ${ghCause}`);
    const sedCause = await analysisCauseForTurn(sessionId, 4);
    if (!/current working directory/i.test(sedCause) || /ripgrep/i.test(sedCause)) fail(`sed No such file did not route to cwd/path analysis: ${sedCause}`);
  });
}

function isForcedAcpFailure(): boolean {
  const command = process.env.LATHE_ANALYST_ACP_COMMAND;
  return Boolean(command && path.basename(command) === 'false');
}

async function withDeterministicAcpAgent<T>(fn: () => Promise<T>): Promise<T> {
  if (isForcedAcpFailure()) return fn();
  const previousCommand = process.env.LATHE_ANALYST_ACP_COMMAND;
  const previousArgs = process.env.LATHE_ANALYST_ACP_ARGS;
  const previousSubmitMode = process.env.FAKE_ACP_SUBMIT_FINDINGS;
  try {
    process.env.LATHE_ANALYST_ACP_COMMAND = process.execPath;
    process.env.LATHE_ANALYST_ACP_ARGS = JSON.stringify([FAKE_ACP_AGENT_PATH]);
    process.env.FAKE_ACP_SUBMIT_FINDINGS = '1';
    return await fn();
  } finally {
    if (previousCommand === undefined) delete process.env.LATHE_ANALYST_ACP_COMMAND;
    else process.env.LATHE_ANALYST_ACP_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.LATHE_ANALYST_ACP_ARGS;
    else process.env.LATHE_ANALYST_ACP_ARGS = previousArgs;
    if (previousSubmitMode === undefined) delete process.env.FAKE_ACP_SUBMIT_FINDINGS;
    else process.env.FAKE_ACP_SUBMIT_FINDINGS = previousSubmitMode;
  }
}

async function verifyDeterministicAcpSubmitPath(): Promise<void> {
  await withScratchDatabase('finding_depth_fake_acp', async () => {
    await applySchema();
    const sessionId = await seedAnalystSession();
    await withDeterministicAcpAgent(async () => {
      for (const candidate of ['llm-v1', 'hybrid-v1'] as const) {
        const result = await runAnalyst({
          candidate,
          sessionIds: [sessionId],
          source: 'smoke',
          maxLlmSessions: 1,
        });
        if (result.skipped || result.created < 1) {
          fail(`${candidate} did not submit through deterministic ACP agent: ${JSON.stringify(result)}`);
        }
      }
    });
    const rows = await getPool().query<{
      id: number;
      analyst: string;
      cause: string | null;
      intent: string | null;
      impact: string | null;
    }>(
      `SELECT id,
              analyst,
              analysis->>'cause_hypothesis' AS cause,
              analysis->>'agent_intent' AS intent,
              analysis->>'impact' AS impact
         FROM findings
        WHERE analyst IN ('llm-v1', 'hybrid-v1')
        ORDER BY analyst ASC, id ASC`,
    );
    for (const analyst of ['llm-v1', 'hybrid-v1']) {
      const row = rows.rows.find((item) => item.analyst === analyst);
      if (!row) fail(`${analyst} deterministic ACP finding was not inserted`);
      const fields = [row.cause, row.intent, row.impact].join('\n');
      if (!fields.includes(`fake-acp-agent ${analyst} sentinel`)) {
        fail(`${analyst} agent-submitted analysis was not preserved: ${JSON.stringify(row)}`);
      }
    }
    await assertAnalysisGrounded([sessionId]);
  });
}

function knownIncidentSessionIds(): string[] {
  const parsed = JSON.parse(fs.readFileSync(KNOWN_INCIDENTS_PATH, 'utf8')) as {
    incidents?: Array<{ session_id?: string }>;
  };
  return [...new Set((parsed.incidents ?? []).map((incident) => incident.session_id).filter((id): id is string => Boolean(id)))];
}

async function copyKnownIncidentRows(sessionIds: string[]): Promise<void> {
  await getPool().query(`
    INSERT INTO projects (id, display_name, git_remote, cwd_hint, created_at, updated_at)
    SELECT id, display_name, git_remote, cwd_hint, created_at, updated_at FROM public.projects
    ON CONFLICT DO NOTHING
  `);
  await getPool().query(`
    INSERT INTO harness_versions (id, project_id, provider, content_hash, captured_at, git_commit)
    SELECT id, project_id, provider, content_hash, captured_at, git_commit FROM public.harness_versions
    ON CONFLICT DO NOTHING
  `);
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
            cost_usd, summary, harness_version_id, NULL::text, NULL::int, seq
       FROM public.sessions
     ON CONFLICT DO NOTHING`,
    [],
  );
  await getPool().query(
    `INSERT INTO transcript_events
     SELECT * FROM public.transcript_events WHERE session_id = ANY($1::text[])
     ON CONFLICT DO NOTHING`,
    [sessionIds],
  );
  await getPool().query(
    `INSERT INTO changed_files
     SELECT * FROM public.changed_files WHERE session_id = ANY($1::text[])
     ON CONFLICT DO NOTHING`,
    [sessionIds],
  );
  await getPool().query(`
    INSERT INTO diff_hunks
    SELECT h.* FROM public.diff_hunks h
    JOIN changed_files cf ON cf.id = h.file_id
    ON CONFLICT DO NOTHING
  `);
  await getPool().query(`
    INSERT INTO attributions
    SELECT a.* FROM public.attributions a
    JOIN diff_hunks h ON h.id = a.hunk_id
    ON CONFLICT DO NOTHING
  `);
}

async function warnKnownIncidentSmoke(): Promise<void> {
  await withScratchDatabase('finding_depth_known', async () => {
    await applySchema();
    const sessionIds = knownIncidentSessionIds();
    if (!sessionIds.length) fail('known incident fixture file has no session ids');
    await copyKnownIncidentRows(sessionIds);
    try {
      const result = await runAnalystSmoke();
      console.warn(`[verify-finding-depth] WARN live_known_incident_smoke=green recall=${JSON.stringify(result.recall)}`);
    } catch (error) {
      console.warn(`[verify-finding-depth] WARN live_known_incident_smoke=red_non_blocking ${(error as Error).message}`);
    }
  });
}

async function verifyAcpFailureFailsClosed(): Promise<void> {
  await withScratchDatabase('finding_depth_acp_required', async () => {
    await applySchema();
    const sessionIds = knownIncidentSessionIds();
    if (!sessionIds.length) fail('known incident fixture file has no session ids');
    await copyKnownIncidentRows(sessionIds);
    const previousCommand = process.env.LATHE_ANALYST_ACP_COMMAND;
    const previousArgs = process.env.LATHE_ANALYST_ACP_ARGS;
    try {
      process.env.LATHE_ANALYST_ACP_COMMAND = '/bin/false';
      delete process.env.LATHE_ANALYST_ACP_ARGS;
      const result = await runAnalyst({
        candidate: 'hybrid-v1',
        sessionIds,
        source: 'smoke',
        maxLlmSessions: sessionIds.length,
      });
      if (!result.skipped) fail(`hybrid-v1 did not fail closed when ACP adapter failed: ${JSON.stringify(result)}`);
      const rows = await getPool().query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM findings WHERE analyst = 'hybrid-v1'`,
      );
      if ((rows.rows[0]?.n ?? 0) !== 0) fail('hybrid-v1 created findings while ACP adapter was forced to fail');
    } finally {
      if (previousCommand === undefined) delete process.env.LATHE_ANALYST_ACP_COMMAND;
      else process.env.LATHE_ANALYST_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.LATHE_ANALYST_ACP_ARGS;
      else process.env.LATHE_ANALYST_ACP_ARGS = previousArgs;
    }
  });
}

async function verifyFinding110To114Backfill(): Promise<void> {
  await withScratchDatabase('finding_depth_existing_findings', async () => {
    await applySchema();
    const ids = [110, 111, 112, 113, 114];
    const rows = await getPool().query<{ id: number }>(
      `SELECT id FROM public.findings WHERE id = ANY($1::int[]) ORDER BY id ASC`,
      [ids],
    );
    if (rows.rows.length !== ids.length) fail(`#110-114 not all present in public findings: ${rows.rows.map((row) => row.id).join(',')}`);
    const sessionIds = (await getPool().query<{ session_id: string }>(
      `SELECT DISTINCT fe.session_id
         FROM public.finding_evidence fe
        WHERE fe.finding_id = ANY($1::int[])
          AND fe.session_id IS NOT NULL`,
      [ids],
    )).rows.map((row) => row.session_id);
    await copyKnownIncidentRows(sessionIds);
    await getPool().query(
      `INSERT INTO findings (id, created_at, analyst, kind, title, body, confidence, harness_version_id, project_id, analysis, backlog_status, backlog_actor)
       OVERRIDING SYSTEM VALUE
       SELECT id, created_at, analyst, kind, title, body, confidence, harness_version_id, project_id, NULL::jsonb, NULL::text, NULL::text
         FROM public.findings
        WHERE id = ANY($1::int[])
       ON CONFLICT DO NOTHING`,
      [ids],
    );
    await getPool().query(
      `INSERT INTO finding_evidence (id, finding_id, subject_kind, session_id, locator, subject_id, note)
       OVERRIDING SYSTEM VALUE
       SELECT id, finding_id, subject_kind, session_id, locator, subject_id, note
         FROM public.finding_evidence
        WHERE finding_id = ANY($1::int[])
       ON CONFLICT DO NOTHING`,
      [ids],
    );
    const result = await backfillFindingAnalysis(ids);
    if (result.updated < 1 && result.skipped < ids.length) fail(`unexpected backfill result: ${JSON.stringify(result)}`);
    const check = await getPool().query<{ id: number; analysis: Record<string, unknown> | string | null }>(
      `SELECT id, analysis FROM findings WHERE id = ANY($1::int[]) ORDER BY id ASC`,
      [ids],
    );
    const missing = check.rows.filter((row) => !row.analysis).map((row) => row.id);
    if (missing.length) fail(`#110-114 missing analysis after scratch backfill: ${missing.join(',')}`);
    await assertAnalysisGrounded(sessionIds);
  });
}

async function main(): Promise<void> {
  await verifyFreshMigration();
  await verifyExistingMigration();
  await verifyRulesAnalysis();
  await verifyGenericAnalysisRejected();
  await verifyCueRouting();
  await verifyDeterministicAcpSubmitPath();
  await verifyAcpFailureFailsClosed();
  await warnKnownIncidentSmoke();
  await verifyFinding110To114Backfill();
  console.log('[verify-finding-depth] GREEN migration=true rules_analysis=true generic_reject=true cue_routing=true fake_acp_submit=true acp_fail_closed=true live_recall=warn backfill_110_114=true');
}

main()
  .catch((error) => {
    console.error(`[verify-finding-depth] ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
