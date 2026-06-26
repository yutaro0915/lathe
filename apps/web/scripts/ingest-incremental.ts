/**
 * CLI entry point for incremental ingest.
 *
 * Usage:
 *   pnpm -C apps/web run ingest:incremental
 *   DATABASE_URL=postgres://... pnpm -C apps/web run ingest:incremental
 *
 * Non-fatal: all errors are caught and logged; process always exits 0 so the
 * calling dev server is never brought down by an ingest failure.
 */
import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';
import { discoverTranscriptDirs } from './ingest/usecase/discover-dirs';
import { runIncrementalIngest } from './ingest/usecase/incremental';

const PREFIX = '[lathe-ingest]';

async function main(): Promise<void> {
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
}

main().catch((err) => {
  console.error(`${PREFIX} fatal error (ingest skipped, dev server unaffected):`, err);
  process.exit(0);
});
