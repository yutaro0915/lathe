import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const source = readFileSync(new URL("./overview-stats.ts", import.meta.url), "utf8");

function modelTokenCast(): string {
  const match = source.match(/COALESCE\(\s*SUM\(token_usage\),\s*0\s*\)::(\w+)\s+tokens/);
  assert.ok(match, "model token SUM projection is present");
  return match[1].toLowerCase();
}

function simulatePgTokenCast(cast: string, sum: number): number {
  if (cast === "int" || cast === "integer" || cast === "int4") {
    if (sum > 2_147_483_647 || sum < -2_147_483_648) {
      const error = new Error("integer out of range") as Error & { code: string };
      error.code = "22003";
      throw error;
    }
    return Math.trunc(sum);
  }
  if (cast === "float8") return sum;
  throw new Error(`Unhandled model token cast: ${cast}`);
}

test("overview model token aggregation does not narrow BIGINT sums to int4", () => {
  const int4OverflowTotal = 2_533_798_934;
  const cast = modelTokenCast();

  assert.doesNotThrow(() => simulatePgTokenCast(cast, int4OverflowTotal));
  assert.equal(simulatePgTokenCast(cast, int4OverflowTotal), int4OverflowTotal);
});
