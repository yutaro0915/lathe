/*
 * Lathe Phase 1 — real transcript ingester.
 * Reads Claude Code and Codex transcripts and populates the configured database.
 *
 * This entry point uses the NO-WIPE incremental path (runIncrementalIngest)
 * across all discovered transcript dirs. It never calls resetDatabase or issues
 * any full DELETE, preventing accidental data-loss on a shared dev DB.
 *
 * For an intentional full rebuild use LATHE_FORCE_RESET=1 and call
 * runFullRebuild directly (or use the verify:incremental scratch path).
 */
import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { discoverTranscriptDirs } from './ingest/usecase/discover-dirs';
import { runIncrementalIngest } from './ingest/usecase/incremental';

const PREFIX = '[ingest]';

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  console.log(`${PREFIX} starting no-wipe incremental ingest (db: ${url.replace(/:[^@]*@/, ':***@')})`);

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
}

main().catch((error) => {
  console.error(`${PREFIX} failed: ${(error as Error).message}`);
  process.exit(1);
});
