import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool } from 'pg';
import type { Runner } from '../../lib/types';
import { getPool } from '../../lib/postgres';
import type { Built } from './built';
import { replaceBuiltSession, type InsertCounts } from './db';
import { buildClaudeSession } from './providers/claude';
import { CodexProvider } from './providers/codex';
import type { ProviderBuildOptions } from './providers/types';

export interface IngestNotifyPayload {
  agent?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  project_id?: string;
  event?: string;
}

export interface IngestNotifyResult {
  ok: true;
  sessionId: string;
  runner: Runner;
  transcriptPath: string;
  projectId: string | null;
  counts: InsertCounts;
}

function buildOptionsFromEnv(): ProviderBuildOptions {
  return {
    maxEvents: Number(process.env.LATHE_MAX_EVENTS || 100000),
    maxFiles: Number(process.env.LATHE_MAX_FILES || 100000),
    maxHunkLines: Number(process.env.LATHE_MAX_HUNK_LINES || 200),
  };
}

function normalizeRunner(agent: string | undefined, transcriptPath: string): Runner {
  const value = (agent || '').toLowerCase();
  if (value === 'claude' || value === 'claude-code' || value === 'claude_code') return 'claude-code';
  if (value === 'codex') return 'codex';
  if (transcriptPath.includes(`${path.sep}.codex${path.sep}`) || path.basename(transcriptPath).startsWith('rollout-')) {
    return 'codex';
  }
  return 'claude-code';
}

function resolveTranscriptPath(payload: IngestNotifyPayload): string {
  if (typeof payload.transcript_path !== 'string' || !payload.transcript_path.trim()) {
    throw new Error('transcript_path is required');
  }

  const rawPath = payload.transcript_path.trim();
  if (path.isAbsolute(rawPath)) return rawPath;
  if (payload.cwd && path.isAbsolute(payload.cwd)) return path.resolve(payload.cwd, rawPath);
  return path.resolve(rawPath);
}

function buildSession(payload: IngestNotifyPayload, transcriptPath: string, runner: Runner): Built {
  const opts = buildOptionsFromEnv();
  const built =
    runner === 'codex'
      ? new CodexProvider(path.basename(payload.cwd || process.cwd()), 1, opts).build(transcriptPath)
      : buildClaudeSession(transcriptPath, opts);

  if (!built || !built.events.length) {
    throw new Error(`no ingestable events found in ${transcriptPath}`);
  }

  if (payload.session_id && built.session.id !== payload.session_id) {
    throw new Error(`session_id mismatch: payload=${payload.session_id} transcript=${built.session.id}`);
  }

  if (payload.project_id?.trim()) {
    built.session.project = payload.project_id.trim();
  } else if (payload.cwd?.trim()) {
    built.session.project = path.basename(payload.cwd.trim());
  }

  return built;
}

export function buildNotifyPayloadFromHook(stdinPayload: unknown, agent: string, projectId?: string): IngestNotifyPayload {
  const record = typeof stdinPayload === 'object' && stdinPayload !== null ? (stdinPayload as Record<string, unknown>) : {};
  return {
    agent,
    session_id: typeof record.session_id === 'string' ? record.session_id : undefined,
    transcript_path: typeof record.transcript_path === 'string' ? record.transcript_path : undefined,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    project_id: projectId,
    event: typeof record.hook_event_name === 'string' ? record.hook_event_name : 'Stop',
  };
}

export async function ingestNotify(payload: IngestNotifyPayload, pool: Pool = getPool()): Promise<IngestNotifyResult> {
  const transcriptPath = resolveTranscriptPath(payload);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`transcript_path does not exist: ${transcriptPath}`);
  }

  const runner = normalizeRunner(payload.agent, transcriptPath);
  const built = buildSession(payload, transcriptPath, runner);
  const counts = await replaceBuiltSession(pool, built);

  return {
    ok: true,
    sessionId: built.session.id,
    runner,
    transcriptPath,
    projectId: payload.project_id?.trim() || null,
    counts,
  };
}
