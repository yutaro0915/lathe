import { strict as assert } from "node:assert";
import { test } from "node:test";
import { types } from "pg";

const INT8_OID = 20;

test("mcp postgres int8 parser preserves numeric row contracts", async () => {
  await import("./postgres");

  const parsed = types.getTypeParser(INT8_OID, "text")("2502729469");

  assert.equal(typeof parsed, "number");
  assert.equal(parsed, 2_502_729_469);
});
