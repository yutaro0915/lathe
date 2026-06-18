import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  basename,
  fmtCompact,
  fmtCost,
  fmtDuration,
  fmtDurationSec,
  fmtInt,
  fmtLatency,
  fmtTok,
  humanizeDuration,
  parseStamp,
  shortModel,
} from "./format";

test("formats counts and token totals for compact UI labels", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtCompact(999), "999");
  assert.equal(fmtCompact(1500), "1.5K");
  assert.equal(fmtCompact(2_500_000), "2.5M");
  assert.equal(fmtTok(999), "999");
  assert.equal(fmtTok(1250), "1.3K");
});

test("formats costs with explicit unknown and tiny positive states", () => {
  assert.equal(fmtCost(null), "—");
  assert.equal(fmtCost(Number.NaN), "—");
  assert.equal(fmtCost(-1), "—");
  assert.equal(fmtCost(0.004), "<$0.01");
  assert.equal(fmtCost(1.2), "$1.20");
});

test("formats durations and latencies across boundary units", () => {
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(0), "—");
  assert.equal(fmtDuration(12_345), "12.3s");
  assert.equal(fmtDuration(90_000), "2m");
  assert.equal(fmtDuration(3_690_000), "1h 2m");
  assert.equal(fmtLatency(null), "—");
  assert.equal(fmtLatency(1234), "1.23s");
  assert.equal(fmtLatency(120_000), "2m");
  assert.equal(humanizeDuration(null), "—");
  assert.equal(humanizeDuration(3723_000), "1h 2m");
  assert.equal(fmtDurationSec(65), "1m 5s");
  assert.equal(fmtDurationSec(3600), "1h 0m");
});

test("formats compact path, timestamp, and model labels", () => {
  assert.equal(shortModel("claude-sonnet-4"), "sonnet-4");
  assert.equal(shortModel(null, "unknown"), "unknown");
  assert.equal(basename("src/app/page.tsx"), "page.tsx");
  assert.deepEqual(parseStamp("2026-06-18 09:34:56"), { date: "Jun 18", time: "09:34" });
});

test("parses both ISO and space timestamp formats without emitting NaN", () => {
  // ISO 8601 from GitHub PR/review timestamps (T-separated, trailing Z) — must not be "Jun NaN".
  assert.deepEqual(parseStamp("2026-06-11T00:01:30Z"), { date: "Jun 11", time: "00:01" });
  // Space-separated session timestamp — existing format must still parse.
  assert.deepEqual(parseStamp("2026-06-12 02:16:26"), { date: "Jun 12", time: "02:16" });
  // Date-only input still yields a valid day and an empty time.
  assert.deepEqual(parseStamp("2026-06-11"), { date: "Jun 11", time: "" });
});
