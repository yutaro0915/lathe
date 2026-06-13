/*
 * Live-transcript detection — shared by the coverage harness (coverage_check.ts)
 * and the cost verifier (verify-cost.ts).
 *
 * A transcript modified within LIVE_WINDOW_MS of "now" is still being written
 * (the current session, or a concurrent cron/agent appending to it). Its
 * ingested snapshot is inherently behind the file on disk, so comparing the DB
 * against the still-growing transcript produces a false mismatch. Both harnesses
 * therefore REPORT such a session but do NOT count it as a failure/omission.
 *
 * The decision is kept here as a pure function so it can be unit-verified with
 * synthetic (live / settled) inputs without a database or real transcripts —
 * see scripts/live.test.ts.
 */
import * as fs from 'node:fs';

/** A transcript whose last write is within this window of "now" is "live". */
export const LIVE_WINDOW_MS = 180_000;

/**
 * Pure: is a transcript with the given last-modified time still being written?
 * `now` and `windowMs` are injectable so tests can pin a deterministic clock.
 */
export function isLiveTranscript(
  mtimeMs: number,
  now: number = Date.now(),
  windowMs: number = LIVE_WINDOW_MS,
): boolean {
  return mtimeMs > now - windowMs;
}

/** Filesystem helper: a transcript file's mtime in ms, or 0 if it cannot be stat'd. */
export function transcriptMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
