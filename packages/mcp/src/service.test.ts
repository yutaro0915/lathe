import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { closePool, DEFAULT_DATABASE_URL, getPool } from "./postgres";
import { getSessionEvents, listMcpSessions } from "./sessions";
import {
  FINDING_BODY_MAX_LENGTH,
  FINDING_EVIDENCE_MAX_ITEMS,
  FINDING_LOCATOR_MAX_LENGTH,
  FINDING_NOTE_MAX_LENGTH,
  FINDING_TITLE_MAX_LENGTH,
  getEvidenceContext,
  parseStoredAnalysis,
  queryFindings,
  stableJson,
  submitFinding,
  type EvidenceSubjectKind,
  type FindingEvidenceInput,
  type SubmitFindingInput,
} from "./service";

const SESSION_CLASSES = ["development", "internal", "auto_review", "synthetic", "sandbox"] as const;

function validFinding(overrides: Partial<SubmitFindingInput> = {}): SubmitFindingInput {
  return {
    analyst: "analyst-1",
    kind: "failure_loop",
    title: "Repeated failed attempt",
    body: "The agent repeated the same failing command.",
    confidence: 0.82,
    projectId: "project-1",
    evidence: [
      {
        subjectKind: "event",
        subjectId: "event-1",
        locator: { seq: 7 },
      },
    ],
    ...overrides,
  };
}

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

async function seedSessionClassFixture(): Promise<void> {
  const pool = getPool();
  const schemaSql = readFileSync(join(process.cwd(), "apps", "web", "db", "schema.sql"), "utf8");
  await pool.query(schemaSql);
  await pool.query(
    `INSERT INTO projects (id, display_name, git_remote, cwd_hint)
     VALUES ('mcp-class-fixture-project', 'MCP class fixture project', NULL, NULL)`,
  );

  for (const [index, sessionClass] of SESSION_CLASSES.entries()) {
    await pool.query(
      `INSERT INTO sessions (
         id, project_id, project, title, runner, model, status, started_at, ended_at,
         duration_ms, turn_count, tool_count, edit_count, bash_count, subagent_count,
         error_count, token_usage, token_in, token_out, git_branch, commit_count,
         cost_usd, summary, harness_version_id, parent_session_id, spawned_by_seq, seq,
         session_class
       )
       VALUES (
         $1, 'mcp-class-fixture-project', 'lathe', $2, 'codex', $3, 'done', $4, $5,
         60000, 1, 1, 0, 1, 0, $6, 42, 24, 18, 'inner/issue-23', 0,
         0.01, 'fixture session', NULL, NULL, NULL, $7, $8
       )`,
      [
        `mcp-class-${sessionClass}`,
        `MCP ${sessionClass} session`,
        sessionClass === "synthetic" ? "<synthetic>" : "gpt-fixture",
        `2026-06-18T00:0${index}:00.000Z`,
        `2026-06-18T00:0${index}:30.000Z`,
        index,
        index,
        sessionClass,
      ],
    );
  }
}

async function withMcpScratchDatabase<T>(fn: () => Promise<T>): Promise<T> {
  const originalDatabaseUrl = currentDatabaseUrl();
  const schema = `mcp_service_${process.pid}_${Date.now()}_${scratchCounter++}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const admin = new Pool({ connectionString: originalDatabaseUrl });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  const previousDatabaseUrl = process.env.DATABASE_URL;
  await closePool();
  process.env.DATABASE_URL = scratchDatabaseUrl(originalDatabaseUrl, schema);

  try {
    await seedSessionClassFixture();
    return await fn();
  } finally {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

test("service re-exports pure finding analysis shaping helpers", () => {
  const cases: Array<{
    name: string;
    value: Parameters<typeof parseStoredAnalysis>[0];
    expected: ReturnType<typeof parseStoredAnalysis>;
  }> = [
    {
      name: "storage JSON string",
      value: '{"cause_hypothesis":" retry loop ","agent_intent":" rerun tests ","impact":" wasted review time "}',
      expected: {
        causeHypothesis: "retry loop",
        agentIntent: "rerun tests",
        impact: "wasted review time",
      },
    },
    {
      name: "storage object with blanks",
      value: { cause_hypothesis: " ", agent_intent: "inspect transcript", impact: null },
      expected: { causeHypothesis: null, agentIntent: "inspect transcript", impact: null },
    },
    {
      name: "invalid JSON shape",
      value: "[1,2]",
      expected: null,
    },
  ];

  for (const { name, value, expected } of cases) {
    assert.deepEqual(parseStoredAnalysis(value), expected, name);
  }
});

test("service re-exports stable JSON used by idempotency and locator length checks", () => {
  const cases: Array<{ name: string; left: unknown; right: unknown; expectedEqual: boolean }> = [
    {
      name: "sorts nested object keys",
      left: { z: 1, a: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, "done"] },
      right: { list: [{ x: 1, y: 2 }, "done"], a: { a: 1, b: 2 }, z: 1 },
      expectedEqual: true,
    },
    {
      name: "preserves array order",
      left: { list: [1, 2] },
      right: { list: [2, 1] },
      expectedEqual: false,
    },
  ];

  for (const { name, left, right, expectedEqual } of cases) {
    assert.equal(stableJson(left) === stableJson(right), expectedEqual, name);
  }
  assert.equal(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("queryFindings rejects invalid pure filters before any database query", async () => {
  const cases: Array<{ name: string; run: () => Promise<unknown>; message: RegExp }> = [
    {
      name: "unknown kind",
      run: () => queryFindings({ kind: "security_bug" as never }),
      message: /invalid finding kind: security_bug/,
    },
    {
      name: "unknown verdict",
      run: () => queryFindings({ verdict: "pending" as never }),
      message: /invalid verdict filter: pending/,
    },
  ];

  for (const { name, run, message } of cases) {
    await assert.rejects(run, message, name);
  }
});

test("submitFinding rejects invalid finding request fields before any database query", async () => {
  const tooManyEvidence = Array.from({ length: FINDING_EVIDENCE_MAX_ITEMS + 1 }, (_, index) => ({
    subjectKind: "event" as const,
    subjectId: `event-${index}`,
  }));
  const cases: Array<{ name: string; input: SubmitFindingInput; message: RegExp }> = [
    {
      name: "blank analyst",
      input: validFinding({ analyst: "   " }),
      message: /finding\.analyst is required/,
    },
    {
      name: "unknown kind",
      input: validFinding({ kind: "security_bug" as never }),
      message: /invalid finding kind: security_bug/,
    },
    {
      name: "blank title",
      input: validFinding({ title: " \t " }),
      message: /finding\.title is required/,
    },
    {
      name: "blank body",
      input: validFinding({ body: "\n " }),
      message: /finding\.body is required/,
    },
    {
      name: "title too long",
      input: validFinding({ title: "x".repeat(FINDING_TITLE_MAX_LENGTH + 1) }),
      message: /finding\.title must be 500 characters or fewer/,
    },
    {
      name: "body too long",
      input: validFinding({ body: "x".repeat(FINDING_BODY_MAX_LENGTH + 1) }),
      message: /finding\.body must be 20000 characters or fewer/,
    },
    {
      name: "negative confidence",
      input: validFinding({ confidence: -0.01 }),
      message: /finding\.confidence must be between 0 and 1/,
    },
    {
      name: "confidence above one",
      input: validFinding({ confidence: 1.01 }),
      message: /finding\.confidence must be between 0 and 1/,
    },
    {
      name: "nan confidence",
      input: validFinding({ confidence: Number.NaN }),
      message: /finding\.confidence must be between 0 and 1/,
    },
    {
      name: "missing evidence array",
      input: validFinding({ evidence: undefined as never }),
      message: /finding\.evidence must contain at least one item/,
    },
    {
      name: "empty evidence",
      input: validFinding({ evidence: [] }),
      message: /finding\.evidence must contain at least one item/,
    },
    {
      name: "too much evidence",
      input: validFinding({ evidence: tooManyEvidence }),
      message: /finding\.evidence must contain 50 items or fewer/,
    },
  ];

  for (const { name, input, message } of cases) {
    await assert.rejects(() => submitFinding(input), message, name);
  }
});

test("submitFinding rejects invalid evidence coordinates before any database query", async () => {
  const evidenceCases: Array<{ name: string; evidence: FindingEvidenceInput; message: RegExp }> = [
    {
      name: "unknown subject kind",
      evidence: { subjectKind: "file" as EvidenceSubjectKind, subjectId: "file-1" },
      message: /invalid evidence subject_kind: file/,
    },
    {
      name: "event without subject id",
      evidence: { subjectKind: "event", subjectId: "  " },
      message: /event evidence requires subject_id/,
    },
    {
      name: "hunk without subject id",
      evidence: { subjectKind: "hunk" },
      message: /hunk evidence requires subject_id/,
    },
    {
      name: "pull request without subject id",
      evidence: { subjectKind: "pr" },
      message: /pr evidence requires subject_id/,
    },
    {
      name: "session without subject or session id",
      evidence: { subjectKind: "session", subjectId: " ", sessionId: "" },
      message: /session evidence requires subject_id or session_id/,
    },
    {
      name: "turn without subject or session id",
      evidence: { subjectKind: "turn" },
      message: /turn evidence requires subject_id or session_id/,
    },
    {
      name: "array locator",
      evidence: { subjectKind: "event", subjectId: "event-1", locator: [] as never },
      message: /evidence locator must be an object when provided/,
    },
    {
      name: "oversized locator",
      evidence: {
        subjectKind: "event",
        subjectId: "event-1",
        locator: { payload: "x".repeat(FINDING_LOCATOR_MAX_LENGTH) },
      },
      message: /evidence\.locator must be 2000 characters or fewer/,
    },
    {
      name: "oversized note",
      evidence: {
        subjectKind: "event",
        subjectId: "event-1",
        note: "x".repeat(FINDING_NOTE_MAX_LENGTH + 1),
      },
      message: /evidence\.note must be 2000 characters or fewer/,
    },
  ];

  for (const { name, evidence, message } of evidenceCases) {
    await assert.rejects(() => submitFinding(validFinding({ evidence: [evidence] })), message, name);
  }
});

test("listMcpSessions defaults to development sessions and exposes sessionClass", async () => {
  await withMcpScratchDatabase(async () => {
    const result = await listMcpSessions({ limit: 10 });
    const blankIncludeResult = await listMcpSessions({ limit: 10, includeClasses: [" ", ""] });

    assert.equal(result.total, 1, "default list should count only development sessions");
    assert.deepEqual(
      result.sessions.map((s) => s.id),
      ["mcp-class-development"],
      "default list should return only development sessions",
    );
    assert.equal(result.sessions[0]?.sessionClass, "development", "summary should expose sessionClass");
    assert.equal(blankIncludeResult.total, 1, "blank includeClasses should fall back to development");
    assert.deepEqual(blankIncludeResult.sessions.map((s) => s.sessionClass), ["development"]);
  });
});

test("listMcpSessions filters one requested session class", async () => {
  await withMcpScratchDatabase(async () => {
    const result = await listMcpSessions({ limit: 10, sessionClass: "internal" });

    assert.equal(result.total, 1, "class filter should count only matching sessions");
    assert.deepEqual(result.sessions.map((s) => s.sessionClass), ["internal"]);
  });
});

test("listMcpSessions includeClasses filters multiple requested session classes", async () => {
  await withMcpScratchDatabase(async () => {
    const result = await listMcpSessions({
      limit: 10,
      sessionClass: "development",
      includeClasses: [" internal ", "sandbox", "", "internal"],
    });

    assert.equal(result.total, 2, "includeClasses should count only included classes after normalization");
    assert.deepEqual(
      result.sessions.map((s) => s.sessionClass).sort(),
      ["internal", "sandbox"],
    );
  });
});

test("listMcpSessions includeClasses can opt in to all known session classes", async () => {
  await withMcpScratchDatabase(async () => {
    const result = await listMcpSessions({ limit: 10, includeClasses: [...SESSION_CLASSES] });

    assert.equal(result.total, SESSION_CLASSES.length, "including every class should count every fixture session");
    assert.deepEqual(
      result.sessions.map((s) => s.sessionClass).sort(),
      [...SESSION_CLASSES].sort(),
    );
  });
});

test("listMcpSessions returns { total, sessions } shape with triage fields", async () => {
  const result = await listMcpSessions({ limit: 1 });
  // 戻り値の形状確認
  assert.ok(typeof result.total === "number", "total should be a number");
  assert.ok(Array.isArray(result.sessions), "sessions should be an array");
  if (result.sessions.length > 0) {
    const s = result.sessions[0];
    // triage フィールドの存在確認
    assert.ok("status" in s, "session should have status");
    assert.ok("turnCount" in s, "session should have turnCount");
    assert.ok("toolCount" in s, "session should have toolCount");
    assert.ok("editCount" in s, "session should have editCount");
    assert.ok("bashCount" in s, "session should have bashCount");
    assert.ok("subagentCount" in s, "session should have subagentCount");
    assert.ok("errorCount" in s, "session should have errorCount");
    assert.ok("tokenUsage" in s, "session should have tokenUsage");
    assert.ok("durationMs" in s, "session should have durationMs");
    assert.ok("startedAt" in s, "session should have startedAt");
    assert.ok("endedAt" in s, "session should have endedAt");
    assert.ok("parentSessionId" in s, "session should have parentSessionId");
    assert.ok("sessionClass" in s, "session should have sessionClass");
    assert.ok(typeof s.turnCount === "number", "turnCount should be a number");
    assert.ok(typeof s.errorCount === "number", "errorCount should be a number");
  }
});

test("listMcpSessions total is consistent with all sessions count", async () => {
  const result = await listMcpSessions({ limit: 200 });
  assert.ok(result.total >= result.sessions.length, "total should be >= returned sessions length");
});

test("listMcpSessions order_by error_count returns numeric errorCount in each session", async () => {
  const result = await listMcpSessions({ limit: 5, orderBy: "error_count" });
  assert.ok(typeof result.total === "number", "total should be a number");
  for (const s of result.sessions) {
    assert.ok(typeof s.errorCount === "number", "errorCount should be a number");
  }
});

test("listMcpSessions order_by unknown value falls back without throwing (whitelist)", async () => {
  // whitelist 外は started_at にフォールバック。エラーを投げないことを確認。
  // orderBy は ListSessionsFilter では string なので型キャストして渡す。
  const result = await listMcpSessions({ limit: 1, orderBy: "unknown_column_xyz" });
  assert.ok(typeof result.total === "number", "should return total without throwing");
});

test("getSessionEvents rejects non-existent session_id", async () => {
  await assert.rejects(
    () => getSessionEvents({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    /session not found/,
    "should throw session not found for unknown id",
  );
});

test("getSessionEvents returns { total, seqRange, events } shape without body/meta", async () => {
  // 既存の session を 1 件取得してから events を問い合わせる
  const sessions = await listMcpSessions({ limit: 1 });
  if (sessions.sessions.length === 0) {
    // DB にデータが無い場合はスキップ（pass）
    return;
  }
  const sessionId = sessions.sessions[0].id;
  const result = await getSessionEvents({ sessionId, limit: 5 });

  assert.ok(typeof result.total === "number", "total should be a number");
  // seqRange は null または { min, max }
  if (result.seqRange !== null) {
    assert.ok(typeof result.seqRange.min === "number", "seqRange.min should be a number");
    assert.ok(typeof result.seqRange.max === "number", "seqRange.max should be a number");
  }
  assert.ok(Array.isArray(result.events), "events should be an array");

  // body / meta フィールドが含まれないことを確認
  for (const ev of result.events) {
    assert.ok(!("body" in ev), "spine event must not contain body");
    assert.ok(!("meta" in ev), "spine event must not contain meta");
    assert.ok(!("filePath" in ev), "spine event must not contain filePath");
    assert.ok(!("parentId" in ev), "spine event must not contain parentId");
    // 期待フィールドが存在する
    assert.ok("seq" in ev, "spine event should have seq");
    assert.ok("type" in ev, "spine event should have type");
    assert.ok("actor" in ev, "spine event should have actor");
  }
});

test("getSessionEvents seq_from / seq_to range filter narrows results", async () => {
  const sessions = await listMcpSessions({ limit: 1 });
  if (sessions.sessions.length === 0) return;
  const sessionId = sessions.sessions[0].id;

  const all = await getSessionEvents({ sessionId, limit: 500 });
  if (all.events.length < 2) return; // データが少なすぎる場合はスキップ

  const midSeq = all.events[Math.floor(all.events.length / 2)].seq;
  const filtered = await getSessionEvents({ sessionId, seqFrom: midSeq, limit: 500 });
  assert.ok(filtered.events.every((e) => e.seq >= midSeq), "all events should satisfy seqFrom");
  assert.ok(filtered.events.length <= all.events.length, "filtered should be <= all");
});

test("getSessionEvents errors_only returns only non-zero exit_code events", async () => {
  const sessions = await listMcpSessions({ limit: 10 });
  // エラーのある session を探す
  const errorSession = sessions.sessions.find((s) => s.errorCount > 0);
  if (!errorSession) return; // データが無ければスキップ

  const result = await getSessionEvents({ sessionId: errorSession.id, errorsOnly: true, limit: 100 });
  for (const ev of result.events) {
    // exitCode は数値（null でない）かつ 0 でない
    assert.ok(ev.exitCode !== null && ev.exitCode !== 0, `event seq=${ev.seq} exitCode=${ev.exitCode} should be non-zero`);
  }
});

test("getEvidenceContext rejects unresolved pure coordinates before any database query", async () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof getEvidenceContext>[0];
    message: RegExp;
  }> = [
    {
      name: "unknown subject kind",
      input: { subjectKind: "file" as EvidenceSubjectKind },
      message: /invalid evidence subject_kind: file/,
    },
    {
      name: "session without ids",
      input: { subjectKind: "session" },
      message: /session evidence context requires subject_id or session_id/,
    },
    {
      name: "event without subject id",
      input: { subjectKind: "event" },
      message: /event evidence context requires subject_id/,
    },
    {
      name: "hunk without subject id",
      input: { subjectKind: "hunk" },
      message: /hunk evidence context requires subject_id/,
    },
    {
      name: "pull request without subject id",
      input: { subjectKind: "pr" },
      message: /pr evidence context requires subject_id/,
    },
    {
      name: "turn without session or sequence",
      input: { subjectKind: "turn", locator: {} },
      message: /turn evidence context could not be resolved/,
    },
  ];

  for (const { name, input, message } of cases) {
    await assert.rejects(() => getEvidenceContext(input), message, name);
  }
});
