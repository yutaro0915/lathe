import { randomUUID } from 'node:crypto';
import { queryOne, queryRows } from './postgres';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type ChatContextKind = 'session' | 'finding' | 'text';

export interface ChatContextAttachment {
  id: string;
  kind: ChatContextKind;
  label: string;
  detail?: string;
  value?: string;
}

export interface ChatContextInput {
  kind: ChatContextKind;
  id?: string;
  value?: string;
  label?: string;
}

export interface ChatThread {
  id: string;
  projectId: string | null;
  title: string;
  sessionId: string | null;
  findingId: number | null;
  createdAt: string;
  updatedAt: string;
  context: ChatContextAttachment[];
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  body: string;
  seq: number;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface ChatThreadRow {
  id: string;
  project_id: string | null;
  title: string;
  session_id: string | null;
  finding_id: number | null;
  created_at: string;
  updated_at: string;
  session_title: string | null;
  finding_title: string | null;
}

interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: string;
  body: string;
  seq: number;
  meta: string | Record<string, unknown> | null;
  created_at: string;
}

const THREAD_SELECT = `
  SELECT t.id, t.project_id, t.title, t.session_id, t.finding_id, t.created_at, t.updated_at,
         s.title AS session_title, f.title AS finding_title
    FROM chat_threads t
    LEFT JOIN sessions s ON s.id = t.session_id
    LEFT JOIN findings f ON f.id = t.finding_id
`;

function parseMeta(meta: ChatMessageRow['meta']): Record<string, unknown> | null {
  if (!meta) return null;
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return meta;
}

function toThread(row: ChatThreadRow): ChatThread {
  const context: ChatContextAttachment[] = [];
  if (row.session_id) {
    context.push({
      id: `session:${row.session_id}`,
      kind: 'session',
      label: row.session_title ? `Session: ${row.session_title}` : `Session: ${row.session_id}`,
      detail: row.session_id,
    });
  }
  if (row.finding_id) {
    context.push({
      id: `finding:${row.finding_id}`,
      kind: 'finding',
      label: row.finding_title ? `Finding: ${row.finding_title}` : `Finding: ${row.finding_id}`,
      detail: String(row.finding_id),
    });
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sessionId: row.session_id,
    findingId: row.finding_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    context,
  };
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ChatRole,
    body: row.body,
    seq: row.seq,
    meta: parseMeta(row.meta),
    createdAt: row.created_at,
  };
}

export async function listChatThreads(): Promise<ChatThread[]> {
  const rows = await queryRows<ChatThreadRow>(`${THREAD_SELECT} ORDER BY t.updated_at DESC, t.id ASC`);
  return rows.map(toThread);
}

export async function getChatThread(threadId: string): Promise<ChatThread | undefined> {
  const row = await queryOne<ChatThreadRow>(`${THREAD_SELECT} WHERE t.id = $1`, [threadId]);
  return row ? toThread(row) : undefined;
}

export async function getChatMessages(threadId: string): Promise<ChatMessage[]> {
  const rows = await queryRows<ChatMessageRow>(
    `SELECT id, thread_id, role, body, seq, meta, created_at
       FROM chat_messages
      WHERE thread_id = $1
      ORDER BY seq ASC, created_at ASC, id ASC`,
    [threadId],
  );
  return rows.map(toMessage);
}

export async function createChatThread(input: {
  title?: string;
  projectId?: string | null;
  sessionId?: string | null;
  findingId?: number | null;
} = {}): Promise<ChatThread> {
  const id = `chat-${randomUUID()}`;
  await queryOne<{ id: string }>(
    `INSERT INTO chat_threads (id, project_id, title, session_id, finding_id)
     VALUES (
       $1,
       COALESCE($2, (SELECT project_id FROM sessions WHERE id = $4), (SELECT project_id FROM findings WHERE id = $5)),
       $3,
       $4,
       $5
     )
     RETURNING id`,
    [id, input.projectId ?? null, input.title?.trim() || 'New chat', input.sessionId ?? null, input.findingId ?? null],
  );
  const thread = await getChatThread(id);
  if (!thread) throw new Error('failed to create chat thread');
  return thread;
}

export async function insertChatMessage(input: {
  threadId: string;
  role: ChatRole;
  body: string;
  meta?: Record<string, unknown> | null;
}): Promise<ChatMessage> {
  const row = await queryOne<ChatMessageRow>(
    `INSERT INTO chat_messages (id, thread_id, role, body, seq, meta)
     SELECT $1, $2, $3, $4, COALESCE(MAX(seq), 0) + 1, $5::jsonb
       FROM chat_messages
      WHERE thread_id = $2
     RETURNING id, thread_id, role, body, seq, meta, created_at`,
    [`msg-${randomUUID()}`, input.threadId, input.role, input.body, JSON.stringify(input.meta ?? {})],
  );
  if (!row) throw new Error('failed to insert chat message');
  return toMessage(row);
}

export async function touchChatThread(threadId: string, title?: string): Promise<ChatThread | undefined> {
  const cleanTitle = title?.trim();
  const updated = await queryOne<{ id: string }>(
    `UPDATE chat_threads
        SET updated_at = CURRENT_TIMESTAMP,
            title = CASE
              WHEN $2::text IS NOT NULL AND title = 'New chat' THEN $2::text
              ELSE title
            END
      WHERE id = $1
      RETURNING id`,
    [threadId, cleanTitle || null],
  );
  return updated ? getChatThread(threadId) : undefined;
}

function compact(text: string | null | undefined, max = 1200): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function titleFromMessage(body: string): string {
  const line = compact(body, 72);
  return line || 'New chat';
}

export async function getChatContextBlocks(thread: ChatThread, contexts: ChatContextInput[]): Promise<string[]> {
  const blocks: string[] = [];
  const wantsSession = thread.sessionId && contexts.some((c) => c.kind === 'session' && c.id === thread.sessionId);
  const wantsFinding = thread.findingId && contexts.some((c) => c.kind === 'finding' && c.id === String(thread.findingId));
  for (const context of contexts) {
    if (context.kind === 'text' && context.value?.trim()) {
      blocks.push(`Free-form context: ${compact(context.value, 1600)}`);
    }
  }
  if (wantsSession) blocks.push(await sessionContextBlock(thread.sessionId!));
  if (wantsFinding) blocks.push(await findingContextBlock(thread.findingId!));
  return blocks.filter(Boolean);
}

async function sessionContextBlock(sessionId: string): Promise<string> {
  const session = await queryOne<{
    id: string; title: string; runner: string; model: string | null; status: string; project: string; summary: string | null;
  }>(
    `SELECT id, title, runner, model, status, project, summary FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) return `Session context requested but not found: ${sessionId}`;
  const events = await queryRows<{ seq: number; type: string; title: string; body: string | null; command: string | null; exit_code: number | null }>(
    `SELECT seq, type, title, body, command, exit_code
       FROM transcript_events
      WHERE session_id = $1
      ORDER BY seq ASC
      LIMIT 24`,
    [sessionId],
  );
  const eventText = events.map((event) => {
    const detail = compact(event.body || event.command || event.title, 420);
    const exit = event.exit_code == null ? '' : ` exit=${event.exit_code}`;
    return `- seq ${event.seq} ${event.type}${exit}: ${detail}`;
  }).join('\n');
  return `Linked session ${session.id}
Title: ${session.title}
Project: ${session.project}
Runner/model/status: ${session.runner} / ${session.model ?? 'unknown'} / ${session.status}
Summary: ${compact(session.summary, 700) || '(none)'}
Transcript excerpt:
${eventText || '(no transcript events)'}`;
}

async function findingContextBlock(findingId: number): Promise<string> {
  const finding = await queryOne<{ id: number; kind: string; title: string; body: string; analyst: string; confidence: number }>(
    `SELECT id, kind, title, body, analyst, confidence FROM findings WHERE id = $1`,
    [findingId],
  );
  if (!finding) return `Finding context requested but not found: ${findingId}`;
  const evidence = await queryRows<{ subject_kind: string; session_id: string | null; subject_id: string | null; note: string | null }>(
    `SELECT subject_kind, session_id, subject_id, note
       FROM finding_evidence
      WHERE finding_id = $1
      ORDER BY id ASC
      LIMIT 12`,
    [findingId],
  );
  const evidenceText = evidence.map((item) =>
    `- ${item.subject_kind} session=${item.session_id ?? 'n/a'} subject=${item.subject_id ?? 'n/a'} ${compact(item.note, 240)}`,
  ).join('\n');
  return `Linked finding ${finding.id}
Kind/title: ${finding.kind} / ${finding.title}
Analyst/confidence: ${finding.analyst} / ${finding.confidence}
Body: ${compact(finding.body, 1200)}
Evidence:
${evidenceText || '(no evidence)'}`;
}

export function buildChatPrompt(input: {
  thread: ChatThread;
  messages: ChatMessage[];
  contextBlocks: string[];
}): string {
  const history = input.messages.slice(-24).map((message) =>
    `${message.role.toUpperCase()} [seq ${message.seq}]:\n${compact(message.body, 4000)}`,
  ).join('\n\n');
  return `You are Lathe Chat, a normal conversational analysis assistant inside the Lathe harness observability app.
Use the attached Lathe context and the read-only Lathe MCP tools when useful.
Do not edit files, run shell commands, submit findings, or claim you performed unavailable actions.

Thread: ${input.thread.title} (${input.thread.id})

Attached context:
${input.contextBlocks.length ? input.contextBlocks.join('\n\n---\n\n') : '(none)'}

Conversation history:
${history}

Answer the latest user message directly and concisely.`;
}
