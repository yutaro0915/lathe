import type { EventType, TurnContext, TurnContextEvent } from '../types';
import { queryOne, queryRows } from '../db.query';
import { type TranscriptEventRow } from './rows';
import { firstLine, truncateExcerpt, truncateTo } from './text';

interface TurnContextSessionRow {
  id: string;
  title: string;
  runner: string;
  model: string | null;
  started_at: string;
  turn_count: number;
}

const TURN_CONTEXT_EVENT_CAP = 200;
const TURN_CONTEXT_TEXT_CHARS = 200;

export async function getTurnContext(
  sessionId: string,
  turn: number,
  evidenceSeqs: number[] = [],
): Promise<TurnContext | undefined> {
  if (!Number.isInteger(turn) || turn < 1) return undefined;
  const session = await queryOne<TurnContextSessionRow>(
    `SELECT id, title, runner, model, started_at, turn_count
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) return undefined;

  // top-level events in seq order; we walk them to find the turn's seq span.
  const rows = await queryRows<TranscriptEventRow>(
    `SELECT * FROM transcript_events
      WHERE session_id = $1 AND parent_id IS NULL
      ORDER BY seq ASC, id ASC`,
    [sessionId],
  );

  // locate the Nth and (N+1)th user_message → [headSeq, nextSeq)
  let seen = 0;
  let headSeq: number | null = null;
  let nextSeq: number | null = null;
  for (const r of rows) {
    if (r.type !== 'user_message') continue;
    seen += 1;
    if (seen === turn) headSeq = r.seq;
    else if (seen === turn + 1) {
      nextSeq = r.seq;
      break;
    }
  }
  if (headSeq == null) return undefined;

  const inTurn = rows.filter(
    (r) => r.seq >= headSeq! && (nextSeq == null || r.seq < nextSeq),
  );
  const totalEvents = inTurn.length;
  const truncated = totalEvents > TURN_CONTEXT_EVENT_CAP;
  const evidenceSet = new Set(evidenceSeqs);

  const events: TurnContextEvent[] = inTurn
    .slice(0, TURN_CONTEXT_EVENT_CAP)
    .map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type as EventType,
      actor: r.actor,
      title: r.title,
      text: truncateTo(firstLine(r.body) ?? r.title, TURN_CONTEXT_TEXT_CHARS),
      command: truncateExcerpt(r.command),
      output: truncateExcerpt(r.body && r.command ? r.body : null),
      exitCode: r.exit_code,
      isEvidence: evidenceSet.has(r.seq),
    }));

  return {
    sessionId: session.id,
    sessionTitle: session.title,
    turn,
    turnCount: session.turn_count ?? events.length,
    headSeq,
    events,
    truncated,
    totalEvents,
  };
}
