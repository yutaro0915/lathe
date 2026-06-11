export const COST_ANOMALY_BASELINE = {
  medianMultiplier: 5,
  absoluteFloorUsd: 50,
  minimumGroupSize: 10,
} as const;

export function costAnomalyThresholdUsd(
  groupMedianUsd: number | null,
  groupSize: number,
): number {
  const { absoluteFloorUsd, medianMultiplier, minimumGroupSize } = COST_ANOMALY_BASELINE;
  if (groupMedianUsd == null || !Number.isFinite(groupMedianUsd) || groupSize < minimumGroupSize) {
    return absoluteFloorUsd;
  }
  return Math.max(groupMedianUsd * medianMultiplier, absoluteFloorUsd);
}

export function isCostAnomaly(
  costUsd: number | null,
  groupMedianUsd: number | null,
  groupSize: number,
): boolean {
  if (costUsd == null || !Number.isFinite(costUsd)) return false;
  return costUsd > costAnomalyThresholdUsd(groupMedianUsd, groupSize);
}
