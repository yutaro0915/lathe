import test from "node:test";
import assert from "node:assert/strict";
import { addToSet, toggleInSet } from "./expand-set";

test("toggleInSet adds a missing id without mutating the original set", () => {
  const original = new Set(["a"]);
  const next = toggleInSet(original, "b");

  assert.notStrictEqual(next, original);
  assert.deepEqual([...original], ["a"]);
  assert.deepEqual([...next].sort(), ["a", "b"]);
});

test("toggleInSet removes an existing id without touching independent ids", () => {
  const original = new Set(["a", "b", "c"]);
  const next = toggleInSet(original, "b");

  assert.notStrictEqual(next, original);
  assert.deepEqual([...original].sort(), ["a", "b", "c"]);
  assert.deepEqual([...next].sort(), ["a", "c"]);
});

test("addToSet is immutable and idempotent", () => {
  const original = new Set(["a"]);
  const added = addToSet(original, "b");
  const repeated = addToSet(added, "b");

  assert.notStrictEqual(added, original);
  assert.notStrictEqual(repeated, added);
  assert.deepEqual([...original], ["a"]);
  assert.deepEqual([...added].sort(), ["a", "b"]);
  assert.deepEqual([...repeated].sort(), ["a", "b"]);
});
