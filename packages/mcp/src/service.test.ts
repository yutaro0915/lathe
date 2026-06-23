import { strict as assert } from "node:assert";
import { test } from "node:test";
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
