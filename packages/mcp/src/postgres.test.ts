import { strict as assert } from "node:assert";
import { test } from "node:test";
import { types } from "pg";
import { closePool, getPool } from "./postgres";

const INT8_OID = 20;

test("mcp postgres int8 parser preserves numeric row contracts", async () => {
  await import("./postgres");

  const parsed = types.getTypeParser(INT8_OID, "text")("2502729469");

  assert.equal(typeof parsed, "number");
  assert.equal(parsed, 2_502_729_469);
});

test("mcp getPool() returns same instance for same URL (singleton)", async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/singleton_a";
  try {
    const pool1 = getPool();
    const pool2 = getPool();
    assert.strictEqual(pool1, pool2, "same URL must return identical instance");
  } finally {
    await closePool();
    process.env.DATABASE_URL = saved;
  }
});

test("mcp getPool() returns new instance when DATABASE_URL changes", async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/url_a";
  try {
    const pool1 = getPool();
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/url_b";
    const pool2 = getPool();
    assert.notStrictEqual(pool1, pool2, "changed URL must return a new instance");
  } finally {
    await closePool();
    process.env.DATABASE_URL = saved;
  }
});

test("mcp getPool() after closePool() returns a fresh instance", async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/fresh_a";
  try {
    const pool1 = getPool();
    await closePool();
    const pool2 = getPool();
    assert.notStrictEqual(pool1, pool2, "after closePool(), next call must return a new instance");
  } finally {
    await closePool();
    process.env.DATABASE_URL = saved;
  }
});
