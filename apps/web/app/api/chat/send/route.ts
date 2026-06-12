import { NextResponse } from 'next/server';
import {
  buildChatAgentRequest,
  chatAgentRequestMeta,
  resolveChatProviderName,
  streamChatAgent,
  type ChatProviderName,
} from '@/lib/chat-agent';
import {
  appendChatMessage,
  createChatThread,
  deriveChatTitle,
  getChatThread,
  listChatMessages,
  MAX_CHAT_MESSAGE_BODY_CHARS,
  setChatThreadTitle,
  updateChatThreadAttachment,
} from '@/lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type JsonRecord = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalFindingId(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function frame(value: JsonRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

async function ensureThread(body: JsonRecord, message: string) {
  const threadId = optionalString(body.threadId);
  const sessionId = optionalString(body.sessionId);
  const findingId = optionalFindingId(body.findingId);
  if (!threadId) {
    return createChatThread({
      title: deriveChatTitle(message),
      sessionId,
      findingId,
    });
  }
  const current = await getChatThread(threadId);
  if (!current) throw new Error(`chat thread not found: ${threadId}`);
  if ((sessionId && current.sessionId !== sessionId) || (findingId && current.findingId !== findingId)) {
    return updateChatThreadAttachment(threadId, { sessionId, findingId });
  }
  return current;
}

export async function POST(request: Request) {
  let body: JsonRecord;
  try {
    body = (await request.json()) as JsonRecord;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const message = optionalString(body.message);
  if (!message) {
    return NextResponse.json({ ok: false, error: 'message is required' }, { status: 400 });
  }
  if (message.length > MAX_CHAT_MESSAGE_BODY_CHARS) {
    return NextResponse.json(
      { ok: false, error: `message must be ${MAX_CHAT_MESSAGE_BODY_CHARS} characters or fewer` },
      { status: 413 },
    );
  }
  const requestedProvider = optionalString(body.provider) as ChatProviderName | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: JsonRecord) => controller.enqueue(frame(value));
      try {
        let thread = await ensureThread(body, message);
        send({ type: 'thread', thread });
        const beforeMessages = await listChatMessages(thread.id);
        const userMessage = await appendChatMessage({
          threadId: thread.id,
          role: 'user',
          body: message,
          meta: { source: 'chat-ui' },
        });
        if (beforeMessages.length === 0 && thread.title === 'New thread') {
          await setChatThreadTitle(thread.id, message);
          thread = (await getChatThread(thread.id)) ?? thread;
          send({ type: 'thread', thread });
        }
        send({ type: 'message', message: userMessage });

        const messages = [...beforeMessages, userMessage];
        const agentRequest = await buildChatAgentRequest({
          threadId: thread.id,
          provider: resolveChatProviderName(requestedProvider),
          messages,
          sessionId: thread.sessionId,
          findingId: thread.findingId,
        });
        const toolCalls: JsonRecord[] = [];
        const toolResults: JsonRecord[] = [];
        let assistantBody = '';
        for await (const event of streamChatAgent(agentRequest)) {
          if (event.type === 'text') {
            if (assistantBody.length + event.text.length > MAX_CHAT_MESSAGE_BODY_CHARS) {
              throw new Error(`assistant message exceeded ${MAX_CHAT_MESSAGE_BODY_CHARS} characters`);
            }
            assistantBody += event.text;
            send({ type: 'delta', text: event.text });
          } else if (event.type === 'tool_call') {
            toolCalls.push({ name: event.name, args: event.args });
            send({ type: 'tool_call', name: event.name });
          } else {
            toolResults.push({ name: event.name, result: event.result });
            send({ type: 'tool_result', name: event.name });
          }
        }
        const assistantMessage = await appendChatMessage({
          threadId: thread.id,
          role: 'assistant',
          body: assistantBody,
          meta: {
            provider: agentRequest.provider,
            request: chatAgentRequestMeta(agentRequest),
            toolCalls,
            toolResults,
          },
        });
        send({ type: 'message', message: assistantMessage });
        send({ type: 'done' });
      } catch (error) {
        send({ type: 'error', error: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
