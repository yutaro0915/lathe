import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  toAnnotation,
  toAttribution,
  toChangedFile,
  toEvent,
  toEventFile,
  toHunk,
  toPullRequest,
  toPullRequestSummary,
  toSession,
  type AnnotationRow,
  type AttributionRow,
  type ChangedFileRow,
  type DiffHunkRow,
  type EventFileRow,
  type PullRequestRow,
  type SessionPrSummaryRow,
  type SessionRow,
  type TranscriptEventRow,
} from "./rows";

function baseSessionRow(): SessionRow {
  return {
    id: "session-1",
    project: "lathe",
    title: "Investigate transcript",
    runner: "codex",
    model: "gpt-5.3-codex",
    status: "running",
    started_at: "2026-06-23T01:02:03.000Z",
    ended_at: "2026-06-23T01:12:03.000Z",
    duration_ms: 600_000,
    turn_count: 7,
    tool_count: 12,
    edit_count: 3,
    bash_count: 4,
    subagent_count: 1,
    error_count: 2,
    token_usage: 42_000,
    token_in: 28_000,
    token_out: 14_000,
    git_branch: "loop/ds-replacement",
    commit_count: 2,
    cost_usd: 1.25,
    cost_anomaly: true,
    cost_anomaly_threshold_usd: 10,
    cost_anomaly_group_size: 5,
    cost_anomaly_group_median_usd: 0.8,
    summary: "Mapped session",
    parent_session_id: "parent-1",
    spawned_by_seq: 19,
    step_count: 31,
    seq: 101,
  };
}

function basePullRequestRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: "pr-1",
    project_id: "lathe",
    number: 42,
    title: "Improve mapper tests",
    body: "PR body",
    state: "open",
    url: "https://github.com/yutaro0915/lathe/pull/42",
    author_login: "cherie",
    head_ref_name: "loop/ds-replacement",
    head_sha: "abc123def456",
    base_ref_name: "main",
    additions: 120,
    deletions: 34,
    changed_files: 5,
    review_count: 2,
    reviews: [{ state: "APPROVED", author: "reviewer" }],
    created_at: "2026-06-22T03:04:05.000Z",
    updated_at: "2026-06-23T04:05:06.000Z",
    merged_at: null,
    ...overrides,
  };
}

test("toSession maps a complete session row field-by-field", () => {
  assert.deepEqual(toSession(baseSessionRow()), {
    id: "session-1",
    project: "lathe",
    title: "Investigate transcript",
    runner: "codex",
    model: "gpt-5.3-codex",
    status: "running",
    startedAt: "2026-06-23T01:02:03.000Z",
    endedAt: "2026-06-23T01:12:03.000Z",
    durationMs: 600_000,
    turnCount: 7,
    toolCount: 12,
    editCount: 3,
    bashCount: 4,
    subagentCount: 1,
    errorCount: 2,
    tokenUsage: 42_000,
    tokenIn: 28_000,
    tokenOut: 14_000,
    gitBranch: "loop/ds-replacement",
    commitCount: 2,
    costUsd: 1.25,
    costAnomaly: true,
    costAnomalyThresholdUsd: 10,
    costAnomalyGroupSize: 5,
    costAnomalyGroupMedianUsd: 0.8,
    summary: "Mapped session",
    parentSessionId: "parent-1",
    spawnedBySeq: 19,
    stepCount: 31,
    seq: 101,
  });
});

test("toSession keeps nullable pg values and defaults nullish ancestry counters", () => {
  const nullRow: SessionRow = {
    ...baseSessionRow(),
    id: "session-null",
    runner: "claude-code",
    model: null,
    status: "failed",
    ended_at: null,
    duration_ms: null,
    git_branch: null,
    cost_usd: null,
    cost_anomaly: false,
    cost_anomaly_group_median_usd: null,
    summary: null,
    parent_session_id: null,
    spawned_by_seq: null,
    step_count: null,
  };
  const undefinedRow = {
    ...nullRow,
    id: "session-undefined",
    parent_session_id: undefined,
    spawned_by_seq: undefined,
    step_count: undefined,
  } as unknown as SessionRow;

  assert.equal(toSession(nullRow).model, null);
  assert.equal(toSession(nullRow).endedAt, null);
  assert.equal(toSession(nullRow).durationMs, null);
  assert.equal(toSession(nullRow).gitBranch, null);
  assert.equal(toSession(nullRow).costUsd, null);
  assert.equal(toSession(nullRow).costAnomalyGroupMedianUsd, null);
  assert.equal(toSession(nullRow).summary, null);
  assert.equal(toSession(nullRow).parentSessionId, null);
  assert.equal(toSession(nullRow).spawnedBySeq, null);
  assert.equal(toSession(nullRow).stepCount, 0);
  assert.equal(toSession(undefinedRow).parentSessionId, null);
  assert.equal(toSession(undefinedRow).spawnedBySeq, null);
  assert.equal(toSession(undefinedRow).stepCount, 0);
});

test("toEvent maps transcript rows with string enums and nullable fields", () => {
  const cases: Array<{ name: string; row: TranscriptEventRow; expected: ReturnType<typeof toEvent> }> = [
    {
      name: "complete bash event",
      row: {
        id: "event-1",
        session_id: "session-1",
        seq: 5,
        ts: "2026-06-23T02:00:00.000Z",
        type: "bash",
        actor: "assistant",
        title: "Run tests",
        body: "stdout",
        file_path: "apps/web/lib/db/rows.ts",
        command: "pnpm test",
        exit_code: 0,
        duration_ms: 1_234,
        token_usage: 99,
        subagent: "worker-1",
        meta: "{\"ok\":true}",
        parent_id: "parent-event",
      },
      expected: {
        id: "event-1",
        sessionId: "session-1",
        seq: 5,
        ts: "2026-06-23T02:00:00.000Z",
        type: "bash",
        actor: "assistant",
        title: "Run tests",
        body: "stdout",
        filePath: "apps/web/lib/db/rows.ts",
        command: "pnpm test",
        exitCode: 0,
        durationMs: 1_234,
        tokenUsage: 99,
        subagent: "worker-1",
        meta: "{\"ok\":true}",
        parentId: "parent-event",
      },
    },
    {
      name: "nullable user message",
      row: {
        id: "event-2",
        session_id: "session-1",
        seq: 6,
        ts: "2026-06-23T02:01:00.000Z",
        type: "user_message",
        actor: "user",
        title: "Ask",
        body: null,
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: null,
        meta: null,
        parent_id: null,
      },
      expected: {
        id: "event-2",
        sessionId: "session-1",
        seq: 6,
        ts: "2026-06-23T02:01:00.000Z",
        type: "user_message",
        actor: "user",
        title: "Ask",
        body: null,
        filePath: null,
        command: null,
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
        subagent: null,
        meta: null,
        parentId: null,
      },
    },
  ];

  for (const { name, row, expected } of cases) {
    assert.deepEqual(toEvent(row), expected, name);
  }
});

test("toChangedFile maps file rows and preserves file status strings", () => {
  const cases: Array<{ row: ChangedFileRow; expected: ReturnType<typeof toChangedFile> }> = [
    {
      row: { id: "file-1", session_id: "session-1", path: "apps/web/lib/db/rows.ts", status: "modified", additions: 8, deletions: 2, language: "TypeScript", seq: 1 },
      expected: { id: "file-1", sessionId: "session-1", path: "apps/web/lib/db/rows.ts", status: "modified", additions: 8, deletions: 2, language: "TypeScript", seq: 1 },
    },
    {
      row: { id: "file-2", session_id: "session-1", path: "README.md", status: "deleted", additions: 0, deletions: 12, language: null, seq: 2 },
      expected: { id: "file-2", sessionId: "session-1", path: "README.md", status: "deleted", additions: 0, deletions: 12, language: null, seq: 2 },
    },
    {
      row: { id: "file-3", session_id: "session-1", path: "src/new.ts", status: "added", additions: 20, deletions: 0, language: "TypeScript", seq: 3 },
      expected: { id: "file-3", sessionId: "session-1", path: "src/new.ts", status: "added", additions: 20, deletions: 0, language: "TypeScript", seq: 3 },
    },
  ];

  for (const { row, expected } of cases) assert.deepEqual(toChangedFile(row), expected);
});

test("toHunk maps diff hunk rows without changing content", () => {
  const row: DiffHunkRow = {
    id: "hunk-1",
    file_id: "file-1",
    seq: 4,
    header: "@@ -1,2 +1,3 @@",
    content: "-old\n+new\n+extra",
  };

  assert.deepEqual(toHunk(row), {
    id: "hunk-1",
    fileId: "file-1",
    seq: 4,
    header: "@@ -1,2 +1,3 @@",
    content: "-old\n+new\n+extra",
  });
});

test("toAttribution maps attribution rows with confidence, method, and nullable notes", () => {
  const cases: Array<{ row: AttributionRow; expected: ReturnType<typeof toAttribution> }> = [
    {
      row: {
        id: "attr-1",
        hunk_id: "hunk-1",
        event_id: "event-1",
        confidence: "high",
        method: "edit_event",
        note: "Direct edit",
      },
      expected: {
        id: "attr-1",
        hunkId: "hunk-1",
        eventId: "event-1",
        confidence: "high",
        method: "edit_event",
        note: "Direct edit",
      },
    },
    {
      row: {
        id: "attr-2",
        hunk_id: "hunk-2",
        event_id: null,
        confidence: "unattributed",
        method: "dirty_worktree",
        note: null,
      },
      expected: {
        id: "attr-2",
        hunkId: "hunk-2",
        eventId: null,
        confidence: "unattributed",
        method: "dirty_worktree",
        note: null,
      },
    },
    {
      row: {
        id: "attr-3",
        hunk_id: "hunk-3",
        event_id: "event-3",
        confidence: "medium",
        method: "shell_inferred",
        note: "Generated by command",
      },
      expected: {
        id: "attr-3",
        hunkId: "hunk-3",
        eventId: "event-3",
        confidence: "medium",
        method: "shell_inferred",
        note: "Generated by command",
      },
    },
  ];

  for (const { row, expected } of cases) assert.deepEqual(toAttribution(row), expected);
});

test("toEventFile maps event file rows and preserves role strings", () => {
  const cases: Array<{ row: EventFileRow; expected: ReturnType<typeof toEventFile> }> = [
    {
      row: { id: 1, event_id: "event-1", path: "src/read.ts", role: "read" },
      expected: { id: 1, eventId: "event-1", path: "src/read.ts", role: "read" },
    },
    {
      row: { id: 2, event_id: "event-2", path: "src/edit.ts", role: "edit" },
      expected: { id: 2, eventId: "event-2", path: "src/edit.ts", role: "edit" },
    },
    {
      row: { id: 3, event_id: "event-3", path: "src/write.ts", role: "write" },
      expected: { id: 3, eventId: "event-3", path: "src/write.ts", role: "write" },
    },
  ];

  for (const { row, expected } of cases) assert.deepEqual(toEventFile(row), expected);
});

test("toAnnotation maps annotation rows with kind and nullable note", () => {
  const cases: Array<{ row: AnnotationRow; expected: ReturnType<typeof toAnnotation> }> = [
    {
      row: { id: 1, session_id: "session-1", at_seq: 4, kind: "error", note: "Failed" },
      expected: { id: 1, sessionId: "session-1", atSeq: 4, kind: "error", note: "Failed" },
    },
    {
      row: { id: 2, session_id: "session-1", at_seq: 5, kind: "commit", note: "abc123" },
      expected: { id: 2, sessionId: "session-1", atSeq: 5, kind: "commit", note: "abc123" },
    },
    {
      row: { id: 3, session_id: "session-1", at_seq: 6, kind: "note", note: null },
      expected: { id: 3, sessionId: "session-1", atSeq: 6, kind: "note", note: null },
    },
  ];

  for (const { row, expected } of cases) assert.deepEqual(toAnnotation(row), expected);
});

test("toPullRequestSummary maps full pull request rows and the explicit link method", () => {
  const row = basePullRequestRow({
    state: "merged",
    merged_at: "2026-06-23T05:06:07.000Z",
  });

  assert.deepEqual(toPullRequestSummary(row, "sha"), {
    id: "pr-1",
    projectId: "lathe",
    number: 42,
    title: "Improve mapper tests",
    state: "merged",
    url: "https://github.com/yutaro0915/lathe/pull/42",
    headRefName: "loop/ds-replacement",
    baseRefName: "main",
    additions: 120,
    deletions: 34,
    changedFiles: 5,
    mergedAt: "2026-06-23T05:06:07.000Z",
    updatedAt: "2026-06-23T04:05:06.000Z",
    linkMethod: "sha",
  });
});

test("toPullRequestSummary maps session summary rows with omitted optional PR stats", () => {
  const row: SessionPrSummaryRow = {
    session_id: "session-1",
    id: "pr-2",
    project_id: "lathe",
    number: 43,
    title: "Linked PR",
    state: "closed",
    url: "https://github.com/yutaro0915/lathe/pull/43",
    head_ref_name: null,
    merged_at: null,
    updated_at: "2026-06-23T07:08:09.000Z",
    link_method: "branch",
    source: "branch",
    pr_updated_at: "2026-06-23T07:08:09.000Z",
  };

  assert.deepEqual(toPullRequestSummary(row), {
    id: "pr-2",
    projectId: "lathe",
    number: 43,
    title: "Linked PR",
    state: "closed",
    url: "https://github.com/yutaro0915/lathe/pull/43",
    headRefName: null,
    baseRefName: undefined,
    additions: undefined,
    deletions: undefined,
    changedFiles: undefined,
    mergedAt: null,
    updatedAt: "2026-06-23T07:08:09.000Z",
    linkMethod: undefined,
  });
  assert.equal(toPullRequestSummary(row, row.link_method).linkMethod, "branch");
});

test("toPullRequest maps a full pull request row and array reviews", () => {
  assert.deepEqual(toPullRequest(basePullRequestRow()), {
    id: "pr-1",
    projectId: "lathe",
    number: 42,
    title: "Improve mapper tests",
    state: "open",
    url: "https://github.com/yutaro0915/lathe/pull/42",
    headRefName: "loop/ds-replacement",
    baseRefName: "main",
    additions: 120,
    deletions: 34,
    changedFiles: 5,
    mergedAt: null,
    updatedAt: "2026-06-23T04:05:06.000Z",
    linkMethod: undefined,
    body: "PR body",
    authorLogin: "cherie",
    headSha: "abc123def456",
    reviewCount: 2,
    reviews: [{ state: "APPROVED", author: "reviewer" }],
    createdAt: "2026-06-22T03:04:05.000Z",
  });
});

test("toPullRequest parses review storage forms and falls back to an empty array", () => {
  const cases: Array<{ name: string; reviews: PullRequestRow["reviews"]; expected: unknown[] }> = [
    {
      name: "json string array",
      reviews: "[{\"state\":\"COMMENTED\"}]",
      expected: [{ state: "COMMENTED" }],
    },
    { name: "json string object", reviews: "{\"state\":\"APPROVED\"}", expected: [] },
    { name: "invalid json", reviews: "not json", expected: [] },
    { name: "null", reviews: null, expected: [] },
  ];

  for (const { name, reviews, expected } of cases) {
    assert.deepEqual(toPullRequest(basePullRequestRow({ reviews })).reviews, expected, name);
  }
});
