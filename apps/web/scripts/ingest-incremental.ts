/**
 * CLI entry point for incremental ingest.
 *
 * Usage:
 *   pnpm -C apps/web run ingest:incremental
 *   DATABASE_URL=postgres://... pnpm -C apps/web run ingest:incremental
 *
 * Non-fatal: all errors are caught and logged; process always exits 0 so the
 * calling dev server is never brought down by an ingest failure.
 *
 * Concurrency guard: uses a PID lock file (/tmp/lathe-ingest.lock) so that
 * at most one ingest process runs at a time. A second invocation exits 0
 * immediately (skip), keeping dev restarts safe.
 */
import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { discoverTranscriptDirs } from './ingest/usecase/discover-dirs';
import { runIncrementalIngest } from './ingest/usecase/incremental';

const PREFIX = '[lathe-ingest]';
const LOCK_FILE = '/tmp/lathe-ingest.lock';

// ---------------------------------------------------------------------------
// PID lock helpers
// ---------------------------------------------------------------------------

/** Returns true if a process with the given pid is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure function: decide what to do with a PID lock file given its current state.
 *
 * No I/O — all inputs are passed in so this is trivially testable.
 *
 * @param exists     - whether the lock file currently exists
 * @param holderPid  - parsed PID from the file (NaN if unreadable/empty)
 * @param holderAlive - whether the holder process is alive (ignored when exists=false)
 * @param selfPid    - the calling process's PID
 * @returns
 *   'acquire'  — no live lock exists; caller should create/overwrite the file
 *   'skip'     — another live process holds the lock; caller should exit
 *   'reclaim'  — lock exists but holder is dead; caller should unlink then acquire
 */
export function decideLock({
  exists,
  holderPid,
  holderAlive,
  selfPid,
}: {
  exists: boolean;
  holderPid: number;
  holderAlive: boolean;
  selfPid: number;
}): 'acquire' | 'skip' | 'reclaim' {
  if (!exists) return 'acquire';
  // Same process (e.g. re-entrant call) — treat as own lock, re-acquire cleanly.
  if (!isNaN(holderPid) && holderPid === selfPid) return 'acquire';
  // Valid PID and process is alive — another live holder.
  if (!isNaN(holderPid) && holderAlive) return 'skip';
  // NaN, 0, or dead PID — stale lock.
  return 'reclaim';
}

/**
 * Attempts to atomically acquire the PID lock.
 *
 * Returns true if acquired, false if another live process holds it.
 * Reclaims stale locks (dead PID) automatically.
 */
function acquireLock(): boolean {
  // Try atomic create-exclusive; throws if file already exists.
  try {
    const fd = openSync(LOCK_FILE, 'wx');
    closeSync(fd);
    writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    return true;
  } catch (err: unknown) {
    // File already exists — check if holder is alive.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    let holderPid = NaN;
    try {
      holderPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    } catch {
      // Can't read — treat as stale (holderPid stays NaN).
    }

    const decision = decideLock({
      exists: true,
      holderPid,
      holderAlive: !isNaN(holderPid) && isAlive(holderPid),
      selfPid: process.pid,
    });

    if (decision === 'skip') {
      console.log(`${PREFIX} another ingest (pid ${holderPid}) running — skip`);
      return false;
    }

    // 'reclaim' (or 'acquire' for self-PID edge case): remove stale/own lock.
    if (decision === 'reclaim') {
      console.log(`${PREFIX} stale lock (pid ${isNaN(holderPid) ? '?' : holderPid} dead) — reclaiming`);
    }
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }

    // Retry once after removing stale/own lock.
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      closeSync(fd);
      writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
      return true;
    } catch {
      // Another process grabbed it between our unlink and retry — give up.
      return false;
    }
  }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!acquireLock()) {
    // Another live ingest is running — exit cleanly, do not disturb dev server.
    process.exit(0);
  }

  try {
    const url = getDatabaseUrl();
    console.log(`${PREFIX} starting incremental ingest (db: ${url.replace(/:[^@]*@/, ':***@')})`);

    const dirs = discoverTranscriptDirs();
    console.log(`${PREFIX} discovered ${dirs.length} transcript dir(s)`);

    const pool = new Pool({ connectionString: url });
    try {
      const result = await runIncrementalIngest(pool, {
        dirs,
        onFile: ({ file, action, error }) => {
          if (action === 'error') {
            console.error(`${PREFIX} error processing ${file}: ${error?.message ?? String(error)}`);
          }
        },
      });

      console.log(
        `${PREFIX} done — dirs=${result.dirsScanned} found=${result.filesFound}` +
          ` upserted=${result.filesUpserted} skipped=${result.filesSkipped}` +
          ` errored=${result.filesErrored}`,
      );
    } finally {
      await pool.end().catch(() => {/* ignore pool teardown errors */});
    }
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Import-main guard: only run main() when this file is the direct entry point.
// When imported by tests (or any other module), main() must not execute so
// that no DB connection or ingest side-effect occurs.
// ---------------------------------------------------------------------------
const _isMain = (() => {
  try {
    // process.argv[1] is the resolved path tsx/node was invoked with.
    // pathToFileURL normalises both sides to comparable file:// URLs.
    return pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
  } catch {
    return false;
  }
})();

if (_isMain) {
  main().catch((err) => {
    console.error(`${PREFIX} fatal error (ingest skipped, dev server unaffected):`, err);
    releaseLock();
    process.exit(0);
  });
}
