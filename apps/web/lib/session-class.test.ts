import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_CLASSES } from "../scripts/ingest/domain/session-class";
import { SESSION_CLASS_OPTIONS } from "./session-class";

test("web session class filter values are derived from the ingest taxonomy", () => {
  const values = SESSION_CLASS_OPTIONS.map((option) => option.value);
  assert.deepEqual(values, [...SESSION_CLASSES, "all"]);

  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "session-class.ts"), "utf8");
  assert.match(source, /SESSION_CLASSES/);
  assert.doesNotMatch(source, /SESSION_CLASS_FILTER_VALUES\s*=/);
});
