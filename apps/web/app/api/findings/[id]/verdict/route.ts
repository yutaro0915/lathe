import { NextResponse } from 'next/server';
import { queryOne, queryRows } from '@/lib/postgres';
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

  let body: { verdict?: unknown; reason?: unknown; actor?: unknown };
  try {
    body = (await request.json()) as { verdict?: unknown; reason?: unknown; actor?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const verdict = body.verdict;
  if (verdict !== 'accept' && verdict !== 'reject') {
    return NextResponse.json({ ok: false, error: 'invalid verdict' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'human';

  const row = await queryOne<VerdictRow>(
    `INSERT INTO finding_verdicts (finding_id, verdict, reason, decided_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, finding_id, verdict, reason, decided_at, decided_by`,
    [findingId, verdict, reason, actor],
  );
  if (!row) {
    return NextResponse.json({ ok: false, error: 'verdict insert failed' }, { status: 500 });
  }

  // Accept = "put on the improvement backlog" (design §B): the moment a finding
  // is accepted its backlog_status becomes 'open'. Reject takes it back off the
  // backlog (null). Only set 'open' on the first accept so a later re-accept does
  // not clobber an 'addressed' / 'dismissed' state the user already chose.
  const backlogStatus =
    verdict === 'accept'
      ? await queryOne<{ backlog_status: string | null }>(
          `UPDATE findings
              SET backlog_status = COALESCE(backlog_status, 'open')
            WHERE id = $1
        RETURNING backlog_status`,
          [findingId],
        )
      : await queryOne<{ backlog_status: string | null }>(
          `UPDATE findings SET backlog_status = NULL WHERE id = $1 RETURNING backlog_status`,
          [findingId],
        );

  return NextResponse.json({
    ok: true,
    verdict: toVerdict(row),
    backlogStatus: backlogStatus?.backlog_status ?? null,
  });
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

  // Undoing the verdict also takes the finding back off the backlog: if no verdict
  // remains, it is no longer "accepted", so backlog_status returns to null.
  const remaining = await queryRows<{ id: number }>(
    `SELECT id FROM finding_verdicts WHERE finding_id = $1 LIMIT 1`,
    [findingId],
  );
  if (remaining.length === 0) {
    await queryOne(`UPDATE findings SET backlog_status = NULL WHERE id = $1 RETURNING id`, [findingId]);
  }
  return NextResponse.json({ ok: true });
}
