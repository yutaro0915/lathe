import { NextResponse } from 'next/server';
import {
  buildChatPrompt,
  getChatContextBlocks,
  getChatMessages,
  getChatThread,
  insertChatMessage,
  titleFromMessage,
  touchChatThread,
  type ChatContextInput,
} from '@/lib/chat';
import { assistantDeltaFromUpdate, runChatAgent } from '@/lib/chat-acp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseContexts(value: unknown): ChatContextInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== 'session' && kind !== 'finding' && kind !== 'text') return [];
    return [{
      kind,
      id: typeof record.id === 'string' ? record.id : undefined,
      label: typeof record.label === 'string' ? record.label : undefined,
      value: typeof record.value === 'string' ? record.value.slice(0, 4000) : undefined,
    }];
  });
}

function sse(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!threadId || !body) {
    return NextResponse.json({ ok: false, error: 'threadId and body are required' }, { status: 400 });
  }

  const thread = await getChatThread(threadId);
  if (!thread) return NextResponse.json({ ok: false, error: 'thread not found' }, { status: 404 });

  const contexts = parseContexts(input?.contexts);
  const userMessage = await insertChatMessage({ threadId, role: 'user', body });
  const updatedThread = await touchChatThread(threadId, titleFromMessage(body));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(sse(encoder, event, data));
      send('user_message', { message: userMessage });
      if (updatedThread) send('thread', { thread: updatedThread });

      let assistantBody = '';
      try {
        const [messages, contextBlocks] = await Promise.all([
          getChatMessages(threadId),
          getChatContextBlocks(updatedThread ?? thread, contexts),
        ]);
        const prompt = buildChatPrompt({ thread: updatedThread ?? thread, messages, contextBlocks });
        const result = await runChatAgent({
          prompt,
          onUpdate: (update) => {
            send('session_update', { update });
            const delta = assistantDeltaFromUpdate(update);
            if (!delta) return;
            assistantBody += delta;
            send('assistant_delta', { delta });
          },
        });
        const finalBody = assistantBody.trim() || `ACP session ended without assistant text (${String(result.prompt.stopReason ?? 'unknown')}).`;
        const assistantMessage = await insertChatMessage({
          threadId,
          role: 'assistant',
          body: finalBody,
          meta: { acpSessionId: result.sessionId, stopReason: String(result.prompt.stopReason ?? '') },
        });
        await touchChatThread(threadId);
        send('assistant_message', { message: assistantMessage });
        send('done', { threadId, acpSessionId: result.sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send('error', { error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
