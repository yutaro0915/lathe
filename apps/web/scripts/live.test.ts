/*
 * Unit verification for the shared live-transcript exclusion used by
 * verify-cost.ts and coverage_check.ts (issue #6).
 *
 * coverage/verify:cost compare real transcripts on disk against the DB, so they
 * cannot reach a verdict in the cloud (no real transcripts). This test isolates
 * the part that issue #6 is about — the live/settled decision — and machine-
 * verifies it against synthetic inputs: a session "still being written" (recent
 * mtime) must be EXCLUDED, while a "settled" session (old mtime) must remain a
 * comparison target. No database, no real transcripts.
 *
 * Run:  pnpm -F web verify:cost:live   (exits non-zero on any failed assertion)
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LIVE_WINDOW_MS, isLiveTranscript, transcriptMtimeMs } from './ingest/live';

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.log(`  FAIL ${name}`);
  }
}

const NOW = 1_700_000_000_000; // fixed clock so the window math is deterministic

// --- pure decision: live vs settled ------------------------------------------
check('updating session (1 min old) is live', () => {
  assert.equal(isLiveTranscript(NOW - 60_000, NOW), true);
});

check('settled session (10 min old) is not live', () => {
  assert.equal(isLiveTranscript(NOW - 600_000, NOW), false);
});

check('boundary: exactly at the window edge is not live', () => {
  assert.equal(isLiveTranscript(NOW - LIVE_WINDOW_MS, NOW), false);
});

check('boundary: 1ms inside the window is live', () => {
  assert.equal(isLiveTranscript(NOW - LIVE_WINDOW_MS + 1, NOW), true);
});

check('un-stat-able transcript (mtime 0) is not live', () => {
  assert.equal(isLiveTranscript(0, NOW), false);
});

// --- the real exclusion behavior over synthetic transcripts on disk ----------
// Mirrors how verify-cost.ts / coverage_check.ts classify each sampled session:
//   isLiveTranscript(transcriptMtimeMs(file), now)
check('live is excluded, settled is kept as a comparison target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-live-'));
  try {
    const liveFile = path.join(dir, 'updating.jsonl');
    const settledFile = path.join(dir, 'settled.jsonl');
    fs.writeFileSync(liveFile, '{"sessionId":"updating"}\n');
    fs.writeFileSync(settledFile, '{"sessionId":"settled"}\n');

    // Pin mtimes: updating == 30s ago (live), settled == 1h ago (comparison target).
    const liveMtime = (NOW - 30_000) / 1000;
    const settledMtime = (NOW - 3_600_000) / 1000;
    fs.utimesSync(liveFile, liveMtime, liveMtime);
    fs.utimesSync(settledFile, settledMtime, settledMtime);

    const sessions = [
      { id: 'updating', file: liveFile },
      { id: 'settled', file: settledFile },
    ];
    const excluded = sessions.filter((s) => isLiveTranscript(transcriptMtimeMs(s.file), NOW)).map((s) => s.id);
    const compared = sessions.filter((s) => !isLiveTranscript(transcriptMtimeMs(s.file), NOW)).map((s) => s.id);

    assert.deepEqual(excluded, ['updating'], 'only the still-being-written session is excluded');
    assert.deepEqual(compared, ['settled'], 'the settled session stays a comparison target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('================ live exclusion unit check ================');
console.log(`window          : ${LIVE_WINDOW_MS}ms`);
console.log(`assertions      : ${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log('--- failures ---');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('==========================================================');
console.log(
  failures.length === 0
    ? 'VERDICT: GREEN - live transcripts are excluded; settled ones are compared.'
    : 'VERDICT: RED - live exclusion logic is broken.',
);
process.exit(failures.length === 0 ? 0 : 1);
