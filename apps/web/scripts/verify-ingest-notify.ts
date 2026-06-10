import * as fs from 'node:fs';
import * as path from 'node:path';
import { closePool, getPool } from '../lib/postgres';
import { pickDefaultTranscriptsDir } from './ingest/shared';
import type { IngestNotifyPayload } from './ingest/notify';

interface Snapshot {
  target: Record<string, number>;
  other: Record<string, number>;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function firstStableClaudeTranscript(): string {
  const dir = process.env.LATHE_TRANSCRIPTS_DIR || pickDefaultTranscriptsDir();
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => {
      const full = path.join(dir, file);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!files.length) throw new Error(`no Claude transcripts found in ${dir}`);

  const cutoff = Date.now() - 180_000;
  return (files.find((file) => file.mtimeMs < cutoff) || files[0]).full;
}

function defaultPayload(): IngestNotifyPayload {
  return {
    agent: 'claude-code',
    transcript_path: firstStableClaudeTranscript(),
    cwd: process.cwd(),
    project_id: process.env.LATHE_VERIFY_PROJECT_ID || 'lathe-verify',
    event: 'Stop',
  };
}

function loadPayload(): IngestNotifyPayload {
  const payloadPath = argValue('--payload');
  if (!payloadPath) return defaultPayload();
  return JSON.parse(fs.readFileSync(payloadPath, 'utf8')) as IngestNotifyPayload;
}

function resolveTranscriptPath(payload: IngestNotifyPayload): string {
  if (!payload.transcript_path) throw new Error('payload transcript_path is required');
  if (path.isAbsolute(payload.transcript_path)) return payload.transcript_path;
  if (payload.cwd && path.isAbsolute(payload.cwd)) return path.resolve(payload.cwd, payload.transcript_path);
  return path.resolve(payload.transcript_path);
}

function inferSessionId(payload: IngestNotifyPayload): string {
  if (payload.session_id) return payload.session_id;

  const transcriptPath = resolveTranscriptPath(payload);
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const isCodex =
    payload.agent === 'codex' ||
    transcriptPath.includes(`${path.sep}.codex${path.sep}`) ||
    path.basename(transcriptPath).startsWith('rollout-');

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (isCodex && record.type === 'session_meta' && record.payload?.id) return record.payload.id;
      if (!isCodex && record.sessionId) return record.sessionId;
    } catch {
      // skip malformed transcript lines
    }
  }

  return path.basename(transcriptPath, '.jsonl');
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await getPool().query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function snapshot(sessionId: string): Promise<Snapshot> {
  return {
    target: {
      sessions: await count('SELECT COUNT(*) FROM sessions WHERE id = $1', [sessionId]),
      transcriptEvents: await count('SELECT COUNT(*) FROM transcript_events WHERE session_id = $1', [sessionId]),
      changedFiles: await count('SELECT COUNT(*) FROM changed_files WHERE session_id = $1', [sessionId]),
      diffHunks: await count(
        `SELECT COUNT(*)
         FROM diff_hunks h
         JOIN changed_files f ON f.id = h.file_id
         WHERE f.session_id = $1`,
        [sessionId],
      ),
      attributions: await count(
        `SELECT COUNT(*)
         FROM attributions a
         JOIN diff_hunks h ON h.id = a.hunk_id
         JOIN changed_files f ON f.id = h.file_id
         WHERE f.session_id = $1`,
        [sessionId],
      ),
      eventFiles: await count(
        `SELECT COUNT(*)
         FROM event_files ef
         JOIN transcript_events e ON e.id = ef.event_id
         WHERE e.session_id = $1`,
        [sessionId],
      ),
      annotations: await count('SELECT COUNT(*) FROM annotations WHERE session_id = $1', [sessionId]),
    },
    other: {
      sessions: await count('SELECT COUNT(*) FROM sessions WHERE id <> $1', [sessionId]),
      transcriptEvents: await count('SELECT COUNT(*) FROM transcript_events WHERE session_id <> $1', [sessionId]),
      changedFiles: await count('SELECT COUNT(*) FROM changed_files WHERE session_id <> $1', [sessionId]),
      diffHunks: await count(
        `SELECT COUNT(*)
         FROM diff_hunks h
         JOIN changed_files f ON f.id = h.file_id
         WHERE f.session_id <> $1`,
        [sessionId],
      ),
      attributions: await count(
        `SELECT COUNT(*)
         FROM attributions a
         JOIN diff_hunks h ON h.id = a.hunk_id
         JOIN changed_files f ON f.id = h.file_id
         WHERE f.session_id <> $1`,
        [sessionId],
      ),
      eventFiles: await count(
        `SELECT COUNT(*)
         FROM event_files ef
         JOIN transcript_events e ON e.id = ef.event_id
         WHERE e.session_id <> $1`,
        [sessionId],
      ),
      annotations: await count('SELECT COUNT(*) FROM annotations WHERE session_id <> $1', [sessionId]),
    },
  };
}

function assertSame(label: string, a: unknown, b: unknown): void {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${label} changed: before=${left} after=${right}`);
}

async function postNotify(baseUrl: string, payload: IngestNotifyPayload): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.LATHE_INGEST_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ingest/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`notify failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  const baseUrl = argValue('--url') || process.env.LATHE_NOTIFY_URL || 'http://localhost:3000';
  const payload = loadPayload();
  const sessionId = inferSessionId(payload);

  const before = await snapshot(sessionId);
  const firstResponse = await postNotify(baseUrl, payload);
  const afterFirst = await snapshot(sessionId);
  const secondResponse = await postNotify(baseUrl, payload);
  const afterSecond = await snapshot(sessionId);

  if (afterFirst.target.sessions !== 1) throw new Error(`target session missing after notify: ${sessionId}`);
  if (afterFirst.target.transcriptEvents < 1) throw new Error(`target transcript_events missing after notify: ${sessionId}`);

  assertSame('other session rows', before.other, afterFirst.other);
  assertSame('idempotent target rows', afterFirst.target, afterSecond.target);
  assertSame('idempotent other rows', afterFirst.other, afterSecond.other);

  console.log(
    `[verify-notify] ok session=${sessionId} events=${afterSecond.target.transcriptEvents} first=${JSON.stringify(firstResponse)} second=${JSON.stringify(secondResponse)}`,
  );
}

main()
  .catch((error) => {
    console.error(`[verify-notify] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
