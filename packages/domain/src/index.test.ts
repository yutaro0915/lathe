import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  FINDING_ANALYSIS_FIELD_MAX_LENGTH,
  assertEvidenceSubjectKind,
  assertFindingKind,
  assertSubjectKind,
  assertVerdictFilter,
  cleanAnalysisText,
  isEvidenceSubjectKind,
  isFindingKind,
  isVerdictFilter,
  normalizeAnalysisForStorage,
  parseJsonObject,
  parseLocator,
  parseStoredAnalysis,
  stableJson,
} from "./index";

test("finding kind guards accept the model vocabulary and reject unknown values", () => {
  assert.equal(isFindingKind("failure_loop"), true);
  assert.equal(isFindingKind("unattributed_diff"), true);
  assert.equal(isFindingKind("excess_cost"), true);
  assert.equal(isFindingKind("risky_action"), true);
  assert.equal(isFindingKind("security_bug"), false);
  assert.doesNotThrow(() => assertFindingKind("risky_action"));
  assert.throws(() => assertFindingKind("security_bug"), /invalid finding kind: security_bug/);
});

test("evidence subject and verdict guards enforce the public filter vocabularies", () => {
  assert.equal(isEvidenceSubjectKind("turn"), true);
  assert.equal(isEvidenceSubjectKind("file"), false);
  assert.equal(isVerdictFilter("unreviewed"), true);
  assert.equal(isVerdictFilter("pending"), false);
  assert.doesNotThrow(() => assertEvidenceSubjectKind("hunk"));
  assert.doesNotThrow(() => assertSubjectKind("session"));
  assert.doesNotThrow(() => assertVerdictFilter("any"));
  assert.throws(() => assertEvidenceSubjectKind("file"), /invalid evidence subject_kind: file/);
  assert.throws(() => assertVerdictFilter("pending"), /invalid verdict filter: pending/);
});

test("stableJson sorts object keys recursively while preserving array order", () => {
  const left = { z: 1, a: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, "done"] };
  const right = { list: [{ x: 1, y: 2 }, "done"], a: { a: 1, b: 2 }, z: 1 };

  assert.equal(stableJson(left), stableJson(right));
  assert.equal(stableJson(left), '{"a":{"a":1,"b":2},"list":[{"x":1,"y":2},"done"],"z":1}');
  assert.notEqual(stableJson({ list: [1, 2] }), stableJson({ list: [2, 1] }));
});

test("parseJsonObject and parseLocator accept only JSON objects", () => {
  assert.deepEqual(parseJsonObject('{"b":2,"a":1}'), { b: 2, a: 1 });
  assert.deepEqual(parseJsonObject({ ok: true }), { ok: true });
  assert.equal(parseJsonObject("[1,2]"), null);
  assert.equal(parseJsonObject("not-json"), null);
  assert.equal(parseJsonObject(null), null);
  assert.deepEqual(parseLocator('{"seq":3}'), { seq: 3 });
  assert.deepEqual(parseLocator("[1,2]"), {});
});

test("analysis text normalization trims, drops blanks, and caps field length", () => {
  assert.equal(cleanAnalysisText("  useful cause  "), "useful cause");
  assert.equal(cleanAnalysisText("   "), null);
  assert.equal(cleanAnalysisText(42), null);
  assert.equal(cleanAnalysisText("x".repeat(FINDING_ANALYSIS_FIELD_MAX_LENGTH + 5))?.length, FINDING_ANALYSIS_FIELD_MAX_LENGTH);
});

test("analysis storage conversion uses snake_case storage and camelCase reads", () => {
  assert.deepEqual(normalizeAnalysisForStorage({ causeHypothesis: " cause ", agentIntent: "", impact: " impact " }), {
    cause_hypothesis: "cause",
    agent_intent: null,
    impact: "impact",
  });
  assert.equal(normalizeAnalysisForStorage({ causeHypothesis: " ", agentIntent: null, impact: undefined }), null);
  assert.deepEqual(
    parseStoredAnalysis('{"cause_hypothesis":" cause ","agent_intent":" intent ","impact":" impact "}'),
    {
      causeHypothesis: "cause",
      agentIntent: "intent",
      impact: "impact",
    },
  );
  assert.equal(parseStoredAnalysis('{"cause_hypothesis":" "}'), null);
  assert.equal(parseStoredAnalysis("[]"), null);
});
