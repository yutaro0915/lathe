import * as crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { ingestNotify, type IngestNotifyPayload } from '../../../../scripts/ingest/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

class NotifyAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireNotifyAuthorization(request: Request): void {
  const expected = process.env.LATHE_NOTIFY_TOKEN?.trim();
  if (!expected) {
    throw new NotifyAuthError('LATHE_NOTIFY_TOKEN is not configured', 503);
  }

  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw new NotifyAuthError('missing notify authorization', 401);
  }
  if (!tokensEqual(match[1].trim(), expected)) {
    throw new NotifyAuthError('invalid notify authorization', 401);
  }
}

export async function POST(request: Request) {
  try {
    requireNotifyAuthorization(request);
  } catch (error) {
    if (error instanceof NotifyAuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    throw error;
  }

  let payload: IngestNotifyPayload;
  try {
    payload = (await request.json()) as IngestNotifyPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const result = await ingestNotify(payload);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 400 });
  }
}
