/*
 * Lathe Phase 1 — real transcript ingester.
 * Reads Claude Code and Codex transcripts and populates the configured database.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Built } from './ingest/built';
import { insertBuilt, resetDatabase } from './ingest/db';
import { ClaudeProvider } from './ingest/providers/claude';
import { CodexProvider } from './ingest/providers/codex';
import type { ProviderBuildOptions, TranscriptProvider } from './ingest/providers/types';
import { pickDefaultTranscriptsDir, repoBasenameOf } from './ingest/shared';

const TRANSCRIPTS_DIR = process.argv[2] || process.env.LATHE_TRANSCRIPTS_DIR || pickDefaultTranscriptsDir();
const MAX_SESSIONS = Number(process.env.LATHE_MAX_SESSIONS || 100000);
const buildOpts: ProviderBuildOptions = {
  maxEvents: Number(process.env.LATHE_MAX_EVENTS || 100000),
  maxFiles: Number(process.env.LATHE_MAX_FILES || 100000),
  maxHunkLines: Number(process.env.LATHE_MAX_HUNK_LINES || 200),
};
const ROOT = process.cwd();
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');

async function main() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.error(`[ingest] transcripts dir not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }

  const providers: TranscriptProvider[] = [new ClaudeProvider(TRANSCRIPTS_DIR, MAX_SESSIONS, buildOpts)];
  if (process.env.LATHE_NO_CODEX !== '1') {
    providers.push(new CodexProvider(process.env.LATHE_CODEX_PROJECT || repoBasenameOf(TRANSCRIPTS_DIR), MAX_SESSIONS, buildOpts));
  }

  const built: Built[] = [];
  const discovered = new Map<string, number>();
  const accepted = new Map<string, number>();
  for (const provider of providers) {
    const files = provider.discover();
    discovered.set(provider.name, files.length);
    for (const file of files) {
      try {
        const b = provider.build(file);
        if (b && b.events.length) {
          built.push(b);
          accepted.set(provider.name, (accepted.get(provider.name) ?? 0) + 1);
        }
      } catch (e) {
        console.error(`[ingest] ${provider.name} failed on ${path.basename(file)}: ${(e as Error).message}`);
      }
    }
  }

  built.sort((a, b) => (b.session._startMs ?? 0) - (a.session._startMs ?? 0));
  built.forEach((b, i) => (b.session.seq = i + 1));
  const db = await resetDatabase(SCHEMA_PATH);
  const counts = await insertBuilt(db, built).finally(() => db.end());
  console.log(
    `[ingest] from ${discovered.get('claude-code') ?? 0} claude transcripts + ${accepted.get('codex') ?? 0} codex sessions: projects=${counts.projects} sessions=${counts.sessions} events=${counts.events} changed_files=${counts.changedFiles} hunks=${counts.hunks} attributions=${counts.attributions} event_files=${counts.eventFiles} annotations=${counts.annotations}`,
  );
}

main().catch((error) => {
  console.error(`[ingest] failed: ${(error as Error).message}`);
  process.exit(1);
});
