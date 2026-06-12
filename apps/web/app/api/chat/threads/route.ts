import { NextResponse } from 'next/server';
import { createChatThread } from '@/lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalFindingId(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const thread = await createChatThread({
    title: optionalString(body.title),
    sessionId: optionalString(body.sessionId),
    findingId: optionalFindingId(body.findingId),
  });
  return NextResponse.json({ ok: true, thread });
}
