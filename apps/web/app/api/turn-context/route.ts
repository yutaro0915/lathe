// app/api/turn-context/route.ts — the embedded transcript for ONE turn of one
// session (Findings triage). The Findings detail panel lazily fetches this when
// the user expands "open this turn's transcript" on an evidence group, so the
// big findings payload (listFindings) is never bloated with full turn bodies.
//
//   GET /api/turn-context?session=<id>&turn=<n>[&seq=<n>&seq=<n>…]
//
// `seq` (repeatable) marks which steps are the finding's own evidence so the
// inline rows can highlight them. The response is the TurnContext shape.

import { NextResponse } from 'next/server';
import { getTurnContext } from '@/lib/read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const turnRaw = url.searchParams.get('turn');
  const turn = Number(turnRaw);

  if (!sessionId || !turnRaw || !Number.isInteger(turn) || turn < 1) {
    return NextResponse.json(
      { ok: false, error: 'session and a positive integer turn are required' },
      { status: 400 },
    );
  }

  const evidenceSeqs = url.searchParams
    .getAll('seq')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0);

  const context = await getTurnContext(sessionId, turn, evidenceSeqs);
  if (!context) {
    return NextResponse.json(
      { ok: false, error: 'turn not found for that session' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, context });
}
