import { NextResponse } from 'next/server';
import { ingestNotify, type IngestNotifyPayload } from '../../../../scripts/ingest/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
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
