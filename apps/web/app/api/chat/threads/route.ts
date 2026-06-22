import { NextResponse } from 'next/server';
import { createChatThread } from '@/lib/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const findingRaw = body.findingId;
  const findingId = typeof findingRaw === 'number' && Number.isInteger(findingRaw) ? findingRaw : null;
  const thread = await createChatThread({
    title: optionalString(body.title) ?? 'New chat',
    projectId: optionalString(body.projectId),
    sessionId: optionalString(body.sessionId),
    findingId,
  });
  return NextResponse.json({ ok: true, thread });
}
