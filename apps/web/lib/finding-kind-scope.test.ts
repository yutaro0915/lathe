import { test } from "node:test";
import { strict as assert } from "node:assert";
import { countFindingKindsForSessionScope } from "./finding-kind-scope";
import type { FindingKindSessionRef } from "./types";

test("countFindingKindsForSessionScope counts each finding once inside the session scope", () => {
  const refs: FindingKindSessionRef[] = [
    { findingId: 1, kind: "failure_loop", sessionId: "dev-a" },
    { findingId: 1, kind: "failure_loop", sessionId: "dev-a" },
    { findingId: 1, kind: "failure_loop", sessionId: "dev-b" },
    { findingId: 2, kind: "failure_loop", sessionId: "internal-a" },
    { findingId: 3, kind: "excess_cost", sessionId: "dev-b" },
  ];

  assert.deepEqual(countFindingKindsForSessionScope(refs, ["dev-a", "dev-b"]), {
    failure_loop: 1,
    unattributed_diff: 0,
    excess_cost: 1,
    risky_action: 0,
  });
});
