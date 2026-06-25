import * as path from 'node:path';
import type { Pool } from 'pg';
import type { Built } from '../built';
import { resolveGitHubToken, syncPullRequestsGraphql } from '../github';
import { ClaudeProvider } from '../providers/claude';
import { CodexProvider } from '../providers/codex';
import type { ProviderBuildOptions, TranscriptProvider } from '../providers/types';
import { repoBasenameOf } from '../shared';
import { resetDatabase } from '../repository/schema';
import { insertBuilt } from '../repository/ingest-writer';
import type { InsertCounts } from '../repository/types';

export interface FullRebuildOptions {
  transcriptsDir: string;
  maxSessions: number;
  buildOpts: ProviderBuildOptions;
  schemaPath: string;
  noCodex?: boolean;
  codexProject?: string;
  log?: (line: string) => void;
}

export interface FullRebuildResult {
  counts: InsertCounts;
  discovered: Map<string, number>;
  accepted: Map<string, number>;
  db: Pool;
}

function repoFromProjectId(projectId: string): string | null {
  const match = /^github\.com\/([^/]+\/[^/]+)$/.exec(projectId);
  return match ? match[1] : null;
}

async function syncPullRequestsCatchup(pool: Pool, log: (line: string) => void = console.log): Promise<void> {
  let token: string;
  try {
    token = resolveGitHubToken();
  } catch (error) {
    log(`[ingest] pr sync skipped: ${(error as Error).message}`);
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
        log: (line) => log(`[ingest] ${line}`),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      log(`[ingest] pr sync failed for ${repo}: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}

export async function runFullRebuild(opts: FullRebuildOptions): Promise<FullRebuildResult> {
  const log = opts.log ?? console.log;
  const providers: TranscriptProvider[] = [new ClaudeProvider(opts.transcriptsDir, opts.maxSessions, opts.buildOpts)];
  if (!opts.noCodex) {
    providers.push(
      new CodexProvider(
        opts.codexProject ?? repoBasenameOf(opts.transcriptsDir),
        opts.maxSessions,
        opts.buildOpts,
      ),
    );
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
        log(`[ingest] ${provider.name} failed on ${path.basename(file)}: ${(e as Error).message}`);
      }
    }
  }

  built.sort((a, b) => (b.session._startMs ?? 0) - (a.session._startMs ?? 0));
  built.forEach((b, i) => (b.session.seq = i + 1));
  const existingHarnessStamps = new Map<string, string>();
  const db = await resetDatabase(opts.schemaPath, { existingHarnessStamps });
  const counts = await insertBuilt(db, built, { existingHarnessStamps });
  await syncPullRequestsCatchup(db, log);

  return { counts, discovered, accepted, db };
}
