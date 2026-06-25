/*
 * Lathe Phase 1 — real transcript ingester.
 * Reads Claude Code and Codex transcripts and populates the configured database.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickDefaultTranscriptsDir } from './ingest/shared';
import { runFullRebuild } from './ingest/usecase/full-rebuild';

const TRANSCRIPTS_DIR = process.argv[2] || process.env.LATHE_TRANSCRIPTS_DIR || pickDefaultTranscriptsDir();
const MAX_SESSIONS = Number(process.env.LATHE_MAX_SESSIONS || 100000);
const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');

async function main() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.error(`[ingest] transcripts dir not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }

  const { counts, discovered, accepted, db } = await runFullRebuild({
    transcriptsDir: TRANSCRIPTS_DIR,
    maxSessions: MAX_SESSIONS,
    buildOpts: {
      maxEvents: Number(process.env.LATHE_MAX_EVENTS || 100000),
      maxFiles: Number(process.env.LATHE_MAX_FILES || 100000),
      maxHunkLines: Number(process.env.LATHE_MAX_HUNK_LINES || 200),
    },
    schemaPath: SCHEMA_PATH,
    noCodex: process.env.LATHE_NO_CODEX === '1',
    codexProject: process.env.LATHE_CODEX_PROJECT,
  });

  await db.end();
  console.log(
    `[ingest] from ${discovered.get('claude-code') ?? 0} claude transcripts + ${accepted.get('codex') ?? 0} codex sessions: projects=${counts.projects} sessions=${counts.sessions} events=${counts.events} session_commits=${counts.sessionCommits} commit_sha_misses=${counts.commitShaMisses} changed_files=${counts.changedFiles} hunks=${counts.hunks} attributions=${counts.attributions} event_files=${counts.eventFiles} annotations=${counts.annotations} harness_versions=${counts.harnessVersions}`,
  );
}

main().catch((error) => {
  console.error(`[ingest] failed: ${(error as Error).message}`);
  process.exit(1);
});
