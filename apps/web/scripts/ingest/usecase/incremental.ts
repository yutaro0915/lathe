/**
 * Incremental multi-directory ingest.
 *
 * Walks multiple transcript dirs, compares each file's mtime against the
 * session already in the DB (using ended_at as an approximation), and calls
 * replaceBuiltSession only for new or changed sessions.
 *
 * Invariants:
 *  - NEVER calls resetDatabase or any full DELETE (no-wipe).
 *  - Correctness is guaranteed by replaceBuiltSession's delete+insert idempotence.
 *  - Mtime comparison is a skip optimisation only; a session will be re-ingested
 *    if its transcript changed even if ended_at suggests otherwise.
 *  - Same session_id appearing in multiple dirs: only the copy with the latest
 *    mtime is processed (prevents double upsert across projects dirs).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { buildClaudeSession } from '../providers/claude';
import {
  buildCodexSession,
  codexHeadSessionId,
  listCodexRollouts,
  loadCodexTitles,
} from '../providers/codex';
import { replaceBuiltSession } from '../repository/ingest-writer';
import type { InsertBuiltOptions } from '../repository/types';
import type { ProviderBuildOptions } from '../providers/types';
import { discoverTranscriptDirs, type TranscriptDir } from './discover-dirs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncrementalIngestOptions {
  /**
   * Override the list of dirs to scan. When omitted, discoverTranscriptDirs()
   * is called to enumerate all dirs under ~/.claude/projects/.
   */
  dirs?: TranscriptDir[];

  /** Provider build options forwarded to buildClaudeSession. */
  buildOpts?: Partial<ProviderBuildOptions>;

  /** Forwarded to replaceBuiltSession. */
  insertOpts?: InsertBuiltOptions;

  /**
   * Override the Codex rollout files to scan. When omitted, listCodexRollouts()
   * is called. Passing [] disables Codex rollout ingestion for hermetic tests.
   */
  codexRolloutFiles?: string[];

  /**
   * Maximum total number of .jsonl files to process (after global dedup).
   * Defaults to 200. Set to Infinity to process all.
   */
  maxFilesPerDir?: number;

  /**
   * Callback invoked for each processed file (for progress logging).
   * `action` is 'skip' when the DB record is current, 'upsert' when replaced.
   */
  onFile?: (opts: { file: string; action: 'skip' | 'upsert' | 'error'; error?: Error }) => void;
}

export interface IncrementalIngestResult {
  dirsScanned: number;
  filesFound: number;
  filesSkipped: number;
  filesUpserted: number;
  filesErrored: number;
  /** Codex rollouts discovered across all projects (no cwd filter). */
  codexRolloutsFound: number;
  codexSkipped: number;
  codexUpserted: number;
  codexErrored: number;
}

// ---------------------------------------------------------------------------
// DB helpers (read-only queries — no wipe)
// ---------------------------------------------------------------------------

/**
 * Fetch ended_at timestamps for a set of session ids from the DB.
 * Returns a Map of sessionId -> ended_at string (or null).
 */
async function fetchEndedAtMap(
  pool: Pool,
  sessionIds: string[],
): Promise<Map<string, string | null>> {
  if (!sessionIds.length) return new Map();
  const res = await pool.query<{ id: string; ended_at: string | null }>(
    `SELECT id, ended_at FROM sessions WHERE id = ANY($1::text[])`,
    [sessionIds],
  );
  const m = new Map<string, string | null>();
  for (const row of res.rows) m.set(row.id, row.ended_at);
  return m;
}

// ---------------------------------------------------------------------------
// Session-id extraction (cheap: reads only the first ~4 KB of the file)
// ---------------------------------------------------------------------------

function extractSessionId(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (typeof r.sessionId === 'string' && r.sessionId) return r.sessionId;
      } catch {
        continue;
      }
    }
    // Fallback: derive from filename (not a real sessionId, just a path key)
    return path.basename(file, '.jsonl') || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure functions: change detection and deduplication
// ---------------------------------------------------------------------------

/**
 * Return true when the transcript file appears newer than the DB record.
 *
 * Heuristic: compare the file's mtime against the session's ended_at timestamp.
 * If ended_at is absent (session not in DB), always re-ingest.
 * If ended_at is present but file mtime is > ended_at + 60 s buffer, re-ingest.
 *
 * @param fileMtimeMs File modification time in milliseconds.
 * @param endedAt     Session's ended_at from DB, or null/undefined if absent.
 */
export function isStale(fileMtimeMs: number, endedAt: string | null | undefined): boolean {
  if (endedAt == null) return true; // not in DB
  const endedMs = Date.parse(endedAt);
  if (Number.isNaN(endedMs)) return true;
  // 60-second buffer to avoid re-ingesting sessions that just finished writing
  return fileMtimeMs > endedMs + 60_000;
}

/**
 * Deduplicate a list of (sessionId, file, mtime) entries by keeping the
 * entry with the latest mtime for each sessionId.
 *
 * This is the core invariant: when the same session_id appears in multiple
 * dirs, only the freshest copy is processed. Dedup happens *before* any
 * per-dir file count limit so that a dir's oldest file can never "win" over
 * another dir's newer copy of the same session.
 *
 * @param entries Array of candidate entries with sessionId, file path, and mtime.
 * @returns       Deduplicated map from sessionId to { file, mtime }.
 */
export function deduplicateByLatestMtime(
  entries: Array<{ sessionId: string; file: string; mtime: number }>,
): Map<string, { file: string; mtime: number }> {
  const result = new Map<string, { file: string; mtime: number }>();
  for (const { sessionId, file, mtime } of entries) {
    const existing = result.get(sessionId);
    if (!existing || mtime > existing.mtime) {
      result.set(sessionId, { file, mtime });
    }
  }
  return result;
}

export function resolveCodexRolloutFiles(
  codexRolloutFiles: string[] | undefined,
  discover: () => string[] = listCodexRollouts,
): string[] {
  return codexRolloutFiles ?? discover();
}

// ---------------------------------------------------------------------------
// Default provider build options
// ---------------------------------------------------------------------------

const DEFAULT_BUILD_OPTS: ProviderBuildOptions = {
  maxEvents: 2000,
  maxFiles: 200,
  maxHunkLines: 400,
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run an incremental ingest across multiple transcript directories.
 *
 * When the same session_id appears in more than one directory (e.g. a project
 * is cloned locally under two different paths), only the file with the latest
 * mtime is processed to prevent double-upsert.
 *
 * Deduplication happens globally *before* the per-dir file count limit is
 * applied, so a dir's oldest file cannot win over another dir's newer copy
 * of the same session (minor2 fix).
 *
 * @param pool   Connected pg Pool to use for reads and writes.
 * @param opts   See IncrementalIngestOptions.
 */
export async function runIncrementalIngest(
  pool: Pool,
  opts: IncrementalIngestOptions = {},
): Promise<IncrementalIngestResult> {
  const {
    dirs = discoverTranscriptDirs(),
    buildOpts = {},
    insertOpts = { backfillHarness: false },
    codexRolloutFiles,
    maxFilesPerDir = 200,
    onFile,
  } = opts;

  // Idempotent migration: ensure session_class column exists before any INSERT.
  // Runs on every no-wipe path (ingest.ts and ingest-incremental.ts both call
  // runIncrementalIngest on main, so a single location covers all entrypoints).
  await pool.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_class TEXT NOT NULL DEFAULT 'development';
    CREATE INDEX IF NOT EXISTS idx_sessions_class ON sessions(session_class);
    CREATE INDEX IF NOT EXISTS idx_events_session ON transcript_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_changed_files_session ON changed_files(session_id);
    CREATE INDEX IF NOT EXISTS idx_diff_hunks_file ON diff_hunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_attributions_hunk ON attributions(hunk_id);
    CREATE INDEX IF NOT EXISTS idx_attributions_event ON attributions(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_files_event ON event_files(event_id);
  `);

  const providerOpts: ProviderBuildOptions = { ...DEFAULT_BUILD_OPTS, ...buildOpts };

  const result: IncrementalIngestResult = {
    dirsScanned: 0,
    filesFound: 0,
    filesSkipped: 0,
    filesUpserted: 0,
    filesErrored: 0,
    codexRolloutsFound: 0,
    codexSkipped: 0,
    codexUpserted: 0,
    codexErrored: 0,
  };

  // -------------------------------------------------------------------------
  // Phase 1: collect all (sessionId, file, mtime) tuples across all dirs,
  //   WITHOUT applying the per-dir limit yet.
  //   Dedup happens globally after collection (minor2 fix).
  // -------------------------------------------------------------------------

  const allEntries: Array<{ sessionId: string; file: string; mtime: number }> = [];
  // Files where extractSessionId returned null (no sessionId in content or name)
  const noIdFiles: Array<{ file: string; mtime: number }> = [];

  for (const transcriptDir of dirs) {
    result.dirsScanned++;

    let entries: string[];
    try {
      entries = fs.readdirSync(transcriptDir.dir);
    } catch {
      continue;
    }

    const files = entries
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(transcriptDir.dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
        return { file, mtime };
      });

    result.filesFound += files.length;

    for (const { file, mtime } of files) {
      const sid = extractSessionId(file);
      if (!sid) {
        noIdFiles.push({ file, mtime });
        continue;
      }
      allEntries.push({ sessionId: sid, file, mtime });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1b: global dedup — keep latest mtime per sessionId, then apply limit.
  // -------------------------------------------------------------------------

  const sessionFileMap = deduplicateByLatestMtime(allEntries);

  // Apply the per-dir-equivalent limit globally after dedup.
  // Sort by descending mtime so the most recent sessions survive the cap.
  const globalLimit = maxFilesPerDir * Math.max(1, dirs.length);
  const sortedSessions = [...sessionFileMap.entries()].sort(
    ([, a], [, b]) => b.mtime - a.mtime,
  );
  const limitedSessions = sortedSessions.slice(0, globalLimit);

  // -------------------------------------------------------------------------
  // Phase 2: batch-fetch ended_at for all unique session ids.
  // -------------------------------------------------------------------------

  const allSessionIds = limitedSessions.map(([sid]) => sid);
  const endedAtMap = await fetchEndedAtMap(pool, allSessionIds);

  // -------------------------------------------------------------------------
  // Phase 3: process — skip fresh sessions, upsert stale ones.
  // -------------------------------------------------------------------------

  async function processFile(file: string, mtime: number, sessionId: string | null): Promise<void> {
    const endedAt = sessionId ? endedAtMap.get(sessionId) : undefined;
    if (!isStale(mtime, endedAt)) {
      result.filesSkipped++;
      onFile?.({ file, action: 'skip' });
      return;
    }
    try {
      const built = buildClaudeSession(file, providerOpts);
      if (!built) {
        result.filesSkipped++;
        onFile?.({ file, action: 'skip' });
        return;
      }
      await replaceBuiltSession(pool, built, insertOpts);
      result.filesUpserted++;
      onFile?.({ file, action: 'upsert' });
    } catch (err) {
      result.filesErrored++;
      onFile?.({ file, action: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  for (const [sid, { file, mtime }] of limitedSessions) {
    await processFile(file, mtime, sid);
  }

  // noId files: use filename-derived key to check DB. Since extractSessionId
  // falls back to the basename, these would have been caught above via the
  // basename fallback. Only truly unreadable files land here (open failed).
  // Skip them — we cannot safely identify them.
  for (const { file, mtime } of noIdFiles) {
    await processFile(file, mtime, null);
  }

  // -------------------------------------------------------------------------
  // Codex path: ingest all rollouts across all projects (no cwd filter).
  //
  // For each rollout we:
  //  1. Cheap-probe the session id from head bytes (codexHeadSessionId).
  //  2. Check isStale against the same endedAt map (fetched per batch below).
  //  3. Build + upsert stale sessions with replaceBuiltSession (no-wipe).
  // -------------------------------------------------------------------------

  const codexRollouts = resolveCodexRolloutFiles(codexRolloutFiles);
  result.codexRolloutsFound = codexRollouts.length;

  if (codexRollouts.length > 0) {
    // Collect (sessionId, file, mtime) for all rollouts.
    const codexEntries: Array<{ sessionId: string; file: string; mtime: number }> = [];
    for (const file of codexRollouts) {
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      const sid = codexHeadSessionId(file); // always returns a non-empty string
      codexEntries.push({ sessionId: sid, file, mtime });
    }

    // Global dedup across codex rollouts (same per-session invariant as claude).
    const codexSessionMap = deduplicateByLatestMtime(codexEntries);

    // Batch-fetch ended_at for all codex session ids in one query.
    const codexSessionIds = [...codexSessionMap.keys()];
    const codexEndedAtMap = await fetchEndedAtMap(pool, codexSessionIds);

    // Load titles once (used by buildCodexSession).
    const titles = loadCodexTitles();

    for (const [sid, { file, mtime }] of codexSessionMap) {
      const endedAt = codexEndedAtMap.get(sid);
      if (!isStale(mtime, endedAt)) {
        result.codexSkipped++;
        onFile?.({ file, action: 'skip' });
        continue;
      }
      try {
        const built = buildCodexSession(file, titles, providerOpts);
        if (!built) {
          result.codexSkipped++;
          onFile?.({ file, action: 'skip' });
          continue;
        }
        await replaceBuiltSession(pool, built, insertOpts);
        result.codexUpserted++;
        onFile?.({ file, action: 'upsert' });
      } catch (err) {
        result.codexErrored++;
        onFile?.({ file, action: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  return result;
}
