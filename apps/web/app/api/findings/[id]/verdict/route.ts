import { NextResponse } from 'next/server';
import { recordFindingBacklogStatus, recordFindingVerdict, undoFindingVerdict } from '@/lib/write';
import type { FindingBacklogStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseFindingId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isBacklogStatus(value: unknown): value is FindingBacklogStatus {
  return value === 'open' || value === 'addressed' || value === 'dismissed';
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const findingId = parseFindingId(rawId);
  if (findingId == null) {
    return NextResponse.json({ ok: false, error: 'invalid finding id' }, { status: 400 });
  }

  let body: { verdict?: unknown; reason?: unknown; backlogStatus?: unknown };
  try {
    body = (await request.json()) as { verdict?: unknown; reason?: unknown; backlogStatus?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const verdict = body.verdict;
  if (verdict !== 'accept' && verdict !== 'reject') {
    return NextResponse.json({ ok: false, error: 'invalid verdict' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const backlogStatus =
    verdict === 'accept'
      ? body.backlogStatus == null
        ? 'open'
        : isBacklogStatus(body.backlogStatus)
          ? body.backlogStatus
          : null
      : null;
  if (verdict === 'accept' && backlogStatus == null) {
    return NextResponse.json({ ok: false, error: 'invalid backlog status' }, { status: 400 });
  }

  const result = await recordFindingVerdict({ findingId, verdict, reason, backlogStatus });
  if (!result) {
    return NextResponse.json({ ok: false, error: 'verdict insert failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const findingId = parseFindingId(rawId);
  if (findingId == null) {
    return NextResponse.json({ ok: false, error: 'invalid finding id' }, { status: 400 });
  }

  let body: { backlogStatus?: unknown };
  try {
    body = (await request.json()) as { backlogStatus?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (!isBacklogStatus(body.backlogStatus)) {
    return NextResponse.json({ ok: false, error: 'invalid backlog status' }, { status: 400 });
  }

  const backlog = await recordFindingBacklogStatus(findingId, body.backlogStatus);
  if (!backlog) {
    return NextResponse.json({ ok: false, error: 'finding not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...backlog });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const findingId = parseFindingId(rawId);
  const verdictId = Number(new URL(request.url).searchParams.get('verdictId'));
  if (findingId == null || !Number.isInteger(verdictId) || verdictId <= 0) {
    return NextResponse.json({ ok: false, error: 'invalid verdict undo target' }, { status: 400 });
  }

  const deleted = await undoFindingVerdict({ findingId, verdictId });
  if (!deleted) {
    return NextResponse.json({ ok: false, error: 'verdict not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
