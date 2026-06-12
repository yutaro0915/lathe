/*
 * Lathe Phase 1 — real transcript ingester.
 * Reads Claude Code and Codex transcripts and populates the configured database.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool } from 'pg';
import type { Built } from './ingest/built';
import { insertBuilt, resetDatabase } from './ingest/db';
import { resolveGitHubToken, syncPullRequestsGraphql } from './ingest/github';
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

function repoFromProjectId(projectId: string): string | null {
  const match = /^github\.com\/([^/]+\/[^/]+)$/.exec(projectId);
  return match ? match[1] : null;
}

async function syncPullRequestsCatchup(pool: Pool): Promise<void> {
  let token: string;
  try {
    token = resolveGitHubToken();
  } catch (error) {
    console.log(`[ingest] pr sync skipped: ${(error as Error).message}`);
    return;
  }

  const projects = await pool.query<{ id: string }>('SELECT id FROM projects ORDER BY id ASC');
  for (const project of projects.rows) {
    const repo = repoFromProjectId(project.id);
    if (!repo) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await syncPullRequestsGraphql(client, {
        repo,
        token,
        log: (line) => console.log(`[ingest] ${line}`),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.log(`[ingest] pr sync failed for ${repo}: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}

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
  const existingHarnessStamps = new Map<string, string>();
  const db = await resetDatabase(SCHEMA_PATH, { existingHarnessStamps });
  const counts = await insertBuilt(db, built, { existingHarnessStamps });
  await syncPullRequestsCatchup(db);
  await db.end();
  console.log(
    `[ingest] from ${discovered.get('claude-code') ?? 0} claude transcripts + ${accepted.get('codex') ?? 0} codex sessions: projects=${counts.projects} sessions=${counts.sessions} events=${counts.events} session_commits=${counts.sessionCommits} commit_sha_misses=${counts.commitShaMisses} changed_files=${counts.changedFiles} hunks=${counts.hunks} attributions=${counts.attributions} event_files=${counts.eventFiles} annotations=${counts.annotations} harness_versions=${counts.harnessVersions}`,
  );
}

main().catch((error) => {
  console.error(`[ingest] failed: ${(error as Error).message}`);
  process.exit(1);
});
