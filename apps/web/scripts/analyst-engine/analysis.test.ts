import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SubmitFindingInput } from "@lathe/domain";
import { analysisJsonPayload, enrichDraftsWithAnalysis } from "./analysis";
import type { AnalystFindingDraft } from "./common";

function draft(overrides: Partial<AnalystFindingDraft> = {}): AnalystFindingDraft {
  return {
    analyst: "rules-v1",
    kind: "failure_loop",
    title: "failed command",
    body: "The selected turn has a non-zero command result.",
    confidence: 0.82,
    projectId: "project-1",
    harnessVersionId: null,
    detector: "unit",
    analysis: {
      causeHypothesis: "Mechanism: the command failed at the selected transcript coordinate.",
      agentIntent: "The agent was responding to a focused verification request.",
      impact: "This identifies the transcript coordinate to review.",
    },
    evidence: [
      {
        subjectKind: "turn",
        sessionId: "session-1",
        locator: { seq: 7 },
        note: "failed exit",
      },
    ],
    ...overrides,
  };
}

test("analysisJsonPayload maps optional analysis fields to storage payload", () => {
  const cases: Array<{
    name: string;
    analysis: NonNullable<SubmitFindingInput["analysis"]>;
    expected: Record<string, string | null>;
  }> = [
    {
      name: "all fields",
      analysis: {
        causeHypothesis: "cause",
        agentIntent: "intent",
        impact: "impact",
      },
      expected: {
        cause_hypothesis: "cause",
        agent_intent: "intent",
        impact: "impact",
      },
    },
    {
      name: "missing optional fields",
      analysis: {
        causeHypothesis: "cause",
      },
      expected: {
        cause_hypothesis: "cause",
        agent_intent: null,
        impact: null,
      },
    },
    {
      name: "explicit null fields",
      analysis: {
        causeHypothesis: null,
        agentIntent: null,
        impact: null,
      },
      expected: {
        cause_hypothesis: null,
        agent_intent: null,
        impact: null,
      },
    },
  ];

  for (const item of cases) {
    assert.deepEqual(analysisJsonPayload(item.analysis), item.expected, item.name);
  }
});

test("enrichDraftsWithAnalysis returns an empty batch without touching integration paths", async () => {
  assert.deepEqual(await enrichDraftsWithAnalysis([]), []);
});

test("enrichDraftsWithAnalysis preserves drafts that already have analysis", async () => {
  const drafts = [
    draft({
      title: "existing failure-loop analysis",
      analysis: {
        causeHypothesis: "Mechanism: existing failure-loop cause.",
        agentIntent: "The agent was running a known verification command.",
        impact: "Review can use the existing analysis directly.",
      },
    }),
    draft({
      kind: "excess_cost",
      title: "existing cost analysis",
      analysis: {
        causeHypothesis: "Mechanism: existing cost cause.",
        impact: "Cost review can use the existing analysis directly.",
      },
      evidence: [],
    }),
  ];

  const enriched = await enrichDraftsWithAnalysis(drafts);

  assert.deepEqual(enriched, drafts);
});
