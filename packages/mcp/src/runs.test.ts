import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";

import { closePool, DEFAULT_DATABASE_URL, getPool } from "./postgres";
import { getRun, listRuns } from "./runs";

let scratchCounter = 0;

function currentDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

function scratchDatabaseUrl(baseDatabaseUrl: string, schema: string): string {
  const url = new URL(baseDatabaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function withRunScratchDatabase<T>(fn: () => Promise<T>): Promise<T> {
  const originalDatabaseUrl = currentDatabaseUrl();
  const schema = `mcp_runs_${process.pid}_${Date.now()}_${scratchCounter++}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const admin = new Pool({ connectionString: originalDatabaseUrl });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  const previousDatabaseUrl = process.env.DATABASE_URL;
  await closePool();
  process.env.DATABASE_URL = scratchDatabaseUrl(originalDatabaseUrl, schema);

  try {
    await seedRunFixture();
    return await fn();
  } finally {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedRunFixture(): Promise<void> {
  const pool = getPool();
  const schemaSql = readFileSync(join(process.cwd(), "apps", "web", "db", "schema.sql"), "utf8");
  await pool.query(schemaSql);
  await pool.query(
    `INSERT INTO projects (id, display_name, git_remote, cwd_hint)
     VALUES
       ('project-a', 'Project A', NULL, NULL),
       ('project-b', 'Project B', NULL, NULL)`,
  );
  await pool.query(
    `INSERT INTO sessions (
       id, project_id, project, title, runner, model, status, started_at, ended_at,
       duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
       error_count, token_usage, token_in, token_out, git_branch, commit_count,
       cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq,
       session_class
     )
     VALUES
       (
         'session-found', 'project-a', 'lathe', 'Found session',
         'codex', 'gpt-fixture', 'done', '2026-07-03T00:00:00.000Z',
         '2026-07-03T00:03:00.000Z', 180000, 4, 2, 1, 1, 0, 0,
         130, 100, 30, 'inner/issue-61', 1, 0.42, 'summary',
         NULL, NULL, NULL, 1, 'auto_review'
       ),
       (
         'session-project-b', 'project-b', 'lathe-b', 'Project B session',
         'claude-code', 'opus-fixture', 'done', '2026-07-03T01:00:00.000Z',
         '2026-07-03T01:01:00.000Z', 60000, 2, 1, 0, 1, 0, 0,
         50, 40, 10, 'inner/issue-61', 0, 0.11, 'summary',
         NULL, NULL, NULL, 2, 'development'
       )`,
  );
  await pool.query(
    `INSERT INTO runs (
       project_id, run_key, manifest_path, source_issue_number, loop_kind,
       stage_count, last_stage, last_verdict, started_at, ended_at,
       has_escalation, escalation_path, manifest_sha256, updated_at
     )
     VALUES
       (
         'project-a', 'issue-61', '.lathe/runs/issue-61.json', 61, 'issue',
         3, 'REVIEW', 'CHANGES_REQUESTED', '2026-07-03T00:00:00.000Z',
         '2026-07-03T00:06:00.000Z', FALSE, NULL, repeat('a', 64),
         '2026-07-03T00:06:00.000Z'
       ),
       (
         'project-a', 'issue-61.attempt1', '.lathe/runs/issue-61.attempt1.json', 61, 'issue',
         1, 'IMPLEMENT', 'ESCALATE', '2026-07-03T00:10:00.000Z',
         '2026-07-03T00:12:00.000Z', TRUE, '.lathe/runs/issue-61.attempt1.escalation.md',
         repeat('b', 64), '2026-07-03T00:12:00.000Z'
       ),
       (
         'project-b', 'issue-61', '.lathe/runs/issue-61.json', 61, 'issue',
         1, 'IMPLEMENT', 'IMPL_DONE', '2026-07-03T01:00:00.000Z',
         '2026-07-03T01:01:00.000Z', FALSE, NULL, repeat('c', 64),
         '2026-07-03T01:01:00.000Z'
       )`,
  );
  await pool.query(
    `INSERT INTO run_stages (
       project_id, run_key, stage_index, stage, session_id, verdict,
       backend, backend_model, head_sha, duration_ms, ts, skipped,
       backend_cost_usd, backend_cost_source, legacy_backend_cost_usd,
       backend_token_usage
     )
     VALUES
       (
         'project-a', 'issue-61', 0, 'PLAN', NULL, 'PLAN_READY',
         'claude', 'opus-plan', 'aaa111', 1000, '2026-07-03T00:01:00.000Z', TRUE,
         NULL, NULL, 0.05, '{"input_tokens":10,"output_tokens":2}'::jsonb
       ),
       (
         'project-a', 'issue-61', 1, 'IMPLEMENT', 'session-found', 'IMPL_DONE',
         'codex', 'gpt-fixture', 'bbb222', 180000, '2026-07-03T00:03:00.000Z', FALSE,
         0.42, 'codex.jsonl.explicit_cost', NULL, '{"input_tokens":100,"output_tokens":30}'::jsonb
       ),
       (
         'project-a', 'issue-61', 2, 'REVIEW', 'missing-session', 'CHANGES_REQUESTED',
         'claude', 'sonnet-review', 'ccc333', 30000, '2026-07-03T00:06:00.000Z', FALSE,
         NULL, NULL, NULL, NULL
       ),
       (
         'project-a', 'issue-61.attempt1', 0, 'IMPLEMENT', 'missing-attempt-session', 'ESCALATE',
         'codex', 'gpt-fixture', 'ddd444', 120000, '2026-07-03T00:12:00.000Z', FALSE,
         1.25, 'codex.jsonl.explicit_cost', NULL, '{"total_tokens":300}'::jsonb
       ),
       (
         'project-b', 'issue-61', 0, 'IMPLEMENT', 'session-project-b', 'IMPL_DONE',
         'claude', 'opus-fixture', 'eee555', 60000, '2026-07-03T01:01:00.000Z', FALSE,
         0.11, 'claude.explicit_cost', NULL, '{"input_tokens":40,"output_tokens":10}'::jsonb
       )`,
  );
}

test("listRuns filters by project and exposes attempt/escalation summary fields", async () => {
  await withRunScratchDatabase(async () => {
    const allProjectRuns = await listRuns({ projectId: "project-a", runKeyPrefix: "issue-61" });

    assert.equal(allProjectRuns.total, 2);
    assert.deepEqual(
      allProjectRuns.runs.map((run) => ({
        project_id: run.project_id,
        run_key: run.run_key,
        is_attempt: run.is_attempt,
        attempt_number: run.attempt_number,
        has_escalation: run.has_escalation,
        last_verdict: run.last_verdict,
      })),
      [
        {
          project_id: "project-a",
          run_key: "issue-61.attempt1",
          is_attempt: true,
          attempt_number: 1,
          has_escalation: true,
          last_verdict: "ESCALATE",
        },
        {
          project_id: "project-a",
          run_key: "issue-61",
          is_attempt: false,
          attempt_number: null,
          has_escalation: false,
          last_verdict: "CHANGES_REQUESTED",
        },
      ],
    );

    const escalatedAttempts = await listRuns({
      projectId: "project-a",
      issueNumber: 61,
      loopKind: "issue",
      runKeyPrefix: "issue-61",
      hasEscalation: true,
      lastVerdict: "ESCALATE",
      limit: 5,
      offset: 0,
    });

    assert.deepEqual(escalatedAttempts.runs.map((run) => run.run_key), ["issue-61.attempt1"]);
  });
});

test("getRun resolves only by project_id and run_key and returns ordered stage session status", async () => {
  await withRunScratchDatabase(async () => {
    const run = await getRun({ projectId: "project-a", runKey: "issue-61" });

    assert.equal(run.project_id, "project-a");
    assert.equal(run.run_key, "issue-61");
    assert.equal(run.stage_count, 3);
    assert.deepEqual(
      run.stages.map((stage) => ({
        stage_index: stage.stage_index,
        stage: stage.stage,
        verdict: stage.verdict,
        session_id: stage.session_id,
        session_status: stage.session_status,
        backend: stage.backend,
        backend_model: stage.backend_model,
        backend_cost_usd: stage.backend_cost_usd,
        legacy_backend_cost_usd: stage.legacy_backend_cost_usd,
        backend_token_usage: stage.backend_token_usage,
        session: stage.session,
      })),
      [
        {
          stage_index: 0,
          stage: "PLAN",
          verdict: "PLAN_READY",
          session_id: null,
          session_status: "no_session_id",
          backend: "claude",
          backend_model: "opus-plan",
          backend_cost_usd: null,
          legacy_backend_cost_usd: 0.05,
          backend_token_usage: { input_tokens: 10, output_tokens: 2 },
          session: null,
        },
        {
          stage_index: 1,
          stage: "IMPLEMENT",
          verdict: "IMPL_DONE",
          session_id: "session-found",
          session_status: "found",
          backend: "codex",
          backend_model: "gpt-fixture",
          backend_cost_usd: 0.42,
          legacy_backend_cost_usd: null,
          backend_token_usage: { input_tokens: 100, output_tokens: 30 },
          session: {
            id: "session-found",
            title: "Found session",
            status: "done",
            runner: "codex",
            model: "gpt-fixture",
            cost_usd: 0.42,
            duration_ms: 180000,
            session_class: "auto_review",
          },
        },
        {
          stage_index: 2,
          stage: "REVIEW",
          verdict: "CHANGES_REQUESTED",
          session_id: "missing-session",
          session_status: "missing",
          backend: "claude",
          backend_model: "sonnet-review",
          backend_cost_usd: null,
          legacy_backend_cost_usd: null,
          backend_token_usage: null,
          session: null,
        },
      ],
    );

    const projectBRun = await getRun({ projectId: "project-b", runKey: "issue-61" });

    assert.equal(projectBRun.project_id, "project-b");
    assert.equal(projectBRun.run_key, "issue-61");
    assert.equal(projectBRun.stages[0]?.session?.id, "session-project-b");
  });
});
