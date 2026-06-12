import { randomUUID } from 'node:crypto';
import { queryOne, queryRows } from './postgres';
import type { ChatMessage, ChatMessageRole, ChatThread } from './types';

type JsonRecord = Record<string, unknown>;

interface ChatThreadRow {
  id: string;
  project_id: string | null;
  title: string;
  session_id: string | null;
  finding_id: number | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: string;
  body: string;
  seq: number;
  meta: string | JsonRecord | null;
  created_at: string;
}

export interface ChatThreadInput {
  title?: string;
  sessionId?: string | null;
  findingId?: number | null;
}

function parseMeta(value: ChatMessageRow['meta']): JsonRecord | null {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function toThread(row: ChatThreadRow): ChatThread {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sessionId: row.session_id,
    findingId: row.finding_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  };
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ChatMessageRole,
    body: row.body,
    seq: row.seq,
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
  };
}

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function deriveChatTitle(message: string): string {
  const firstLine = message.replace(/\s+/g, ' ').trim();
  if (!firstLine) return 'New thread';
  return firstLine.length > 54 ? `${firstLine.slice(0, 51)}...` : firstLine;
}

async function inferProjectId(input: ChatThreadInput): Promise<string | null> {
  if (input.sessionId) {
    const row = await queryOne<{ project_id: string }>('SELECT project_id FROM sessions WHERE id = $1', [
      input.sessionId,
    ]);
    if (row) return row.project_id;
  }
  if (input.findingId) {
    const row = await queryOne<{ project_id: string }>('SELECT project_id FROM findings WHERE id = $1', [
      input.findingId,
    ]);
    if (row) return row.project_id;
  }
  return null;
}

export async function listChatThreads(): Promise<ChatThread[]> {
  const rows = await queryRows<ChatThreadRow>(
    `SELECT t.*,
            COUNT(m.id)::int AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
      GROUP BY t.id
      ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC`,
  );
  return rows.map(toThread);
}

export async function getChatThread(id: string): Promise<ChatThread | undefined> {
  const row = await queryOne<ChatThreadRow>(
    `SELECT t.*,
            COUNT(m.id)::int AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
      WHERE t.id = $1
      GROUP BY t.id`,
    [id],
  );
  return row ? toThread(row) : undefined;
}

export async function listChatMessages(threadId: string): Promise<ChatMessage[]> {
  const rows = await queryRows<ChatMessageRow>(
    `SELECT id,thread_id,role,body,seq,meta,created_at
       FROM chat_messages
      WHERE thread_id = $1
      ORDER BY seq ASC, created_at ASC, id ASC`,
    [threadId],
  );
  return rows.map(toMessage);
}

export async function createChatThread(input: ChatThreadInput = {}): Promise<ChatThread> {
  const id = `chat_${randomUUID()}`;
  const projectId = await inferProjectId(input);
  const title = cleanString(input.title) ?? 'New thread';
  const row = await queryOne<ChatThreadRow>(
    `INSERT INTO chat_threads (id,project_id,title,session_id,finding_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id,project_id,title,session_id,finding_id,created_at,updated_at,0::int AS message_count`,
    [id, projectId, title, cleanString(input.sessionId ?? null), input.findingId ?? null],
  );
  if (!row) throw new Error('chat thread insert failed');
  return toThread(row);
}

export async function updateChatThreadAttachment(
  threadId: string,
  input: Pick<ChatThreadInput, 'sessionId' | 'findingId'>,
): Promise<ChatThread> {
  const projectId = await inferProjectId(input);
  const row = await queryOne<ChatThreadRow>(
    `UPDATE chat_threads
        SET session_id = COALESCE($2, session_id),
            finding_id = COALESCE($3, finding_id),
            project_id = COALESCE(project_id, $4),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id,project_id,title,session_id,finding_id,created_at,updated_at,
                (SELECT COUNT(*)::int FROM chat_messages WHERE thread_id = $1) AS message_count`,
    [threadId, cleanString(input.sessionId ?? null), input.findingId ?? null, projectId],
  );
  if (!row) throw new Error(`chat thread not found: ${threadId}`);
  return toThread(row);
}

export async function setChatThreadTitle(threadId: string, title: string): Promise<void> {
  await queryRows(
    `UPDATE chat_threads
        SET title = $2,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [threadId, deriveChatTitle(title)],
  );
}

export async function appendChatMessage(input: {
  threadId: string;
  role: ChatMessageRole;
  body: string;
  meta?: JsonRecord | null;
}): Promise<ChatMessage> {
  const id = `msg_${randomUUID()}`;
  const row = await queryOne<ChatMessageRow>(
    `WITH next_seq AS (
       SELECT COALESCE(MAX(seq), 0) + 1 AS seq
         FROM chat_messages
        WHERE thread_id = $1
     ), inserted AS (
       INSERT INTO chat_messages (id,thread_id,role,body,seq,meta)
       SELECT $2,$1,$3,$4,next_seq.seq,$5::jsonb
         FROM next_seq
       RETURNING id,thread_id,role,body,seq,meta,created_at
     )
     UPDATE chat_threads
        SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING (SELECT id FROM inserted) AS id,
                (SELECT thread_id FROM inserted) AS thread_id,
                (SELECT role FROM inserted) AS role,
                (SELECT body FROM inserted) AS body,
                (SELECT seq FROM inserted) AS seq,
                (SELECT meta FROM inserted) AS meta,
                (SELECT created_at FROM inserted) AS created_at`,
    [
      input.threadId,
      id,
      input.role,
      input.body,
      input.meta == null ? null : JSON.stringify(input.meta),
    ],
  );
  if (!row) throw new Error('chat message insert failed');
  return toMessage(row);
}
