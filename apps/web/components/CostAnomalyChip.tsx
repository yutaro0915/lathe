import { fmtCost } from "@lathe/shared";
import type { Session } from "@/lib/types";

export default function CostAnomalyChip({ session }: { session: Session }) {
  if (!session.costAnomaly) return null;
  const median = fmtCost(session.costAnomalyGroupMedianUsd);
  return (
    <span
      className="chip anomaly-chip"
      data-anomaly="cost"
      data-threshold-usd={session.costAnomalyThresholdUsd.toFixed(6)}
      title={`Cost ${fmtCost(session.costUsd)} exceeds baseline ${fmtCost(session.costAnomalyThresholdUsd)} · runner n=${session.costAnomalyGroupSize} · median ${median}`}
    >
      ▲ cost
    </span>
  );
}
