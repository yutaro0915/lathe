import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectRiskyActions } from "./rules";
import type { EventRow, SessionRow } from "./common";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    project_id: "project-1",
    title: "fixture session",
    runner: "codex",
    model: null,
    cost_usd: null,
    error_count: 0,
    edit_count: 0,
    turn_count: 1,
    harness_version_id: null,
    cost_group_size: 0,
    cost_group_median_usd: null,
    cost_threshold_usd: 50,
    cost_anomaly: false,
    ...overrides,
  };
}

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "event-1",
    session_id: "session-1",
    seq: 7,
    type: "tool",
    title: "shell command",
    body: null,
    command: "echo ok",
    exit_code: 0,
    ...overrides,
  };
}

test("detectRiskyActions reports high-impact shell command patterns", () => {
  const sessions = new Map([["session-1", session()]]);
  const findings = detectRiskyActions(
    "rules-v1",
    sessions,
    [event({ command: "git reset --hard HEAD~1" })],
    { candidate: "rules-v1" },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "risky_action");
  assert.equal(findings[0].detector, "risky_command_pattern");
  assert.equal(findings[0].confidence, 0.87);
  assert.deepEqual(findings[0].evidence[0], {
    subjectKind: "turn",
    sessionId: "session-1",
    locator: { seq: 7 },
    note: "risky command cue",
  });
});

test("detectRiskyActions ignores benign commands and missing sessions", () => {
  assert.deepEqual(
    detectRiskyActions("rules-v1", new Map([["session-1", session()]]), [event({ command: "pnpm test" })], {
      candidate: "rules-v1",
    }),
    [],
  );
  assert.deepEqual(
    detectRiskyActions("rules-v1", new Map(), [event({ command: "rm -rf dist" })], { candidate: "rules-v1" }),
    [],
  );
});

test("detectRiskyActions supports turn scoping and bisection accident cues", () => {
  const sessions = new Map([["session-1", session()]]);
  const findings = detectRiskyActions(
    "rules-v1",
    sessions,
    [
      event({ id: "event-1", seq: 6, body: "二分法で進め、見落としを無視した" }),
      event({ id: "event-2", seq: 7, body: "二分法で進め、見落としを無視した" }),
    ],
    { candidate: "rules-v1", turn: { sessionId: "session-1", seq: 7 } },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].detector, "bisection_accident_cue");
  assert.equal(findings[0].evidence[0].locator?.seq, 7);
});
