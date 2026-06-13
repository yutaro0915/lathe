import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/postgres';
import type { BacklogStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Backlog state-transition API (design/phase2-finding-depth-and-backlog.md §B +
// design/agent-human-dual-operability.md). This is the SAME endpoint the human
// buttons call and a future agent tool will call — the only difference is the
// `actor` field on the body. Human clicks send actor:"human"; an MCP tool would
// send actor:"agent:<name>". The transition itself is identical, so the two
// operators are interchangeable at the data layer (the founding dual-operability
// principle). Harness application stays manual / outside Lathe in P2 — this only
// records WHICH backlog state the user (or agent) declared.
//
// Allowed targets: 'open' | 'addressed' | 'dismissed'. The finding must already be
// on the backlog (i.e. accepted, backlog_status NOT NULL) — you cannot move a
// pending/rejected finding's backlog state, mirroring "Accept = put on backlog".

const ALLOWED: ReadonlySet<string> = new Set<BacklogStatus>(['open', 'addressed', 'dismissed']);

function parseFindingId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await context.params;
  const findingId = parseFindingId(rawId);
  if (findingId == null) {
    return NextResponse.json({ ok: false, error: 'invalid finding id' }, { status: 400 });
  }

  let body: { status?: unknown; actor?: unknown };
  try {
    body = (await request.json()) as { status?: unknown; actor?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const status = body.status;
  if (typeof status !== 'string' || !ALLOWED.has(status)) {
    return NextResponse.json(
      { ok: false, error: 'invalid backlog status (open | addressed | dismissed)' },
      { status: 400 },
    );
  }
  // actor is recorded for the dual-operability audit trail. Default to "human"
  // (the UI button); an agent tool passes "agent:<name>". Kept permissive here —
  // the column for a full actor log is a later migration; for now we validate and
  // echo it so the contract is stable.
  const actor =
    typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'human';

  // Only transition a finding that is already accepted (backlog_status NOT NULL).
  const row = await queryOne<{ id: number; backlog_status: string }>(
    `UPDATE findings
        SET backlog_status = $2
      WHERE id = $1
        AND backlog_status IS NOT NULL
    RETURNING id, backlog_status`,
    [findingId, status],
  );
  if (!row) {
    return NextResponse.json(
      { ok: false, error: 'finding is not on the backlog (accept it first)' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    findingId: row.id,
    backlogStatus: row.backlog_status as BacklogStatus,
    actor,
  });
}
