import { useMemo } from "react";
import type { TurnRollup } from "./types";

// useTurnJumps — derives the two header "jump" targets the MetricsBar surfaces:
// the highest-cost (or highest-duration, for non-priceable runs) turn, and the
// first turn that carried an error. Extracted from SessionViewer (file-size I4)
// so the viewer stays focused on wiring; the rollup math lives here.
export function useTurnJumps(runner: string, turnRollups: Map<string, Omit<TurnRollup, "collapsed">>) {
  const highestTurnJump = useMemo(() => {
    let best: { headerId: string; turn: number; score: number; basis: "cost" | "duration" } | null = null;
    const useCostBasis = runner === "claude-code" && [...turnRollups.values()].some((r) => r.costUsd != null && Number.isFinite(r.costUsd));
    for (const [headerId, r] of turnRollups.entries()) {
      const basis: "cost" | "duration" = useCostBasis ? "cost" : "duration";
      const score = basis === "cost" ? (r.costUsd ?? -1) : r.wallDurationMs > 0 ? r.wallDurationMs : r.durationMs;
      if (score < 0) continue;
      if (!best || score > best.score || (score === best.score && r.turn < best.turn)) best = { headerId, turn: r.turn, score, basis };
    }
    return best;
  }, [runner, turnRollups]);

  const firstErrorTurnJump = useMemo(() => {
    for (const [headerId, r] of [...turnRollups.entries()].sort((a, b) => a[1].turn - b[1].turn)) {
      if (r.errors > 0) return { headerId, turn: r.turn, errors: r.errors };
    }
    return null;
  }, [turnRollups]);

  return { highestTurnJump, firstErrorTurnJump };
}
