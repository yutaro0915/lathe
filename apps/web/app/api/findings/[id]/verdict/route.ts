import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/postgres';
import type { FindingVerdict, FindingVerdictValue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VerdictRow {
  id: number;
  finding_id: number;
  verdict: string;
  reason: string | null;
  decided_at: string;
  decided_by: string;
}

function toVerdict(row: VerdictRow): FindingVerdict {
  return {
    id: row.id,
    findingId: row.finding_id,
    verdict: row.verdict as FindingVerdictValue,
    reason: row.reason,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function parseFindingId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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

  let body: { verdict?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { verdict?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const verdict = body.verdict;
  if (verdict !== 'accept' && verdict !== 'reject') {
    return NextResponse.json({ ok: false, error: 'invalid verdict' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const row = await queryOne<VerdictRow>(
    `INSERT INTO finding_verdicts (finding_id, verdict, reason)
     VALUES ($1, $2, $3)
     RETURNING id, finding_id, verdict, reason, decided_at, decided_by`,
    [findingId, verdict, reason],
  );
  if (!row) {
    return NextResponse.json({ ok: false, error: 'verdict insert failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, verdict: toVerdict(row) });
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

  const row = await queryOne<{ id: number }>(
    `DELETE FROM finding_verdicts
      WHERE finding_id = $1
        AND id = $2
      RETURNING id`,
    [findingId, verdictId],
  );
  if (!row) {
    return NextResponse.json({ ok: false, error: 'verdict not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
