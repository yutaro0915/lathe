import type { FindingKindCounts, FindingKindSessionRef } from "./types";

const EMPTY_FINDING_KIND_COUNTS: FindingKindCounts = {
  failure_loop: 0,
  unattributed_diff: 0,
  excess_cost: 0,
  risky_action: 0,
};

export function emptyFindingKindCounts(): FindingKindCounts {
  return { ...EMPTY_FINDING_KIND_COUNTS };
}

export function countFindingKindsForSessionScope(
  refs: readonly FindingKindSessionRef[],
  sessionIds: readonly string[],
): FindingKindCounts {
  const sessionSet = new Set(sessionIds);
  const seen = new Set<number>();
  const out = emptyFindingKindCounts();

  for (const ref of refs) {
    if (!sessionSet.has(ref.sessionId)) continue;
    if (seen.has(ref.findingId)) continue;
    seen.add(ref.findingId);
    out[ref.kind] += 1;
  }

  return out;
}
