import { strict as assert } from "node:assert";
import { test } from "node:test";
import { costAnomalyThresholdUsd, isCostAnomaly } from "./cost-anomaly";

test("costAnomalyThresholdUsd uses the absolute floor without a stable median group", () => {
  assert.equal(costAnomalyThresholdUsd(null, 20), 50);
  assert.equal(costAnomalyThresholdUsd(Number.NaN, 20), 50);
  assert.equal(costAnomalyThresholdUsd(20, 9), 50);
});

test("costAnomalyThresholdUsd uses the larger of median multiplier and absolute floor", () => {
  assert.equal(costAnomalyThresholdUsd(4, 10), 50);
  assert.equal(costAnomalyThresholdUsd(12, 10), 60);
});

test("isCostAnomaly requires a finite cost above the computed threshold", () => {
  assert.equal(isCostAnomaly(null, 12, 10), false);
  assert.equal(isCostAnomaly(Number.POSITIVE_INFINITY, 12, 10), false);
  assert.equal(isCostAnomaly(60, 12, 10), false);
  assert.equal(isCostAnomaly(60.01, 12, 10), true);
});

test("isCostAnomaly remains false for costs between the floor and median baseline", () => {
  assert.equal(isCostAnomaly(55, 12, 10), false);
});
