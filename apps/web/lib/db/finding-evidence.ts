import type {
  FindingEvidence,
  FindingEvidenceExcerpt,
  FindingEvidenceNarrative,
  FindingKind,
} from '../types';
import { queryRows } from '../db.query';
import { EVIDENCE_NARRATIVE_CHARS, firstLine, truncateExcerpt, truncateTo } from './text';
import { locatorSeq } from './finding-rows';

interface EvidenceEventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  title: string;
  command: string | null;
  body: string | null;
  exit_code: number | null;
}

// Lightweight event shape used to reconstruct the narrative (trigger / position /
// aftermath) for a session — fetched once per involved session, not per evidence.
interface NarrativeEventRow {
  session_id: string;
  seq: number;
  ts: string;
  type: string;
  title: string;
  body: string | null;
  exit_code: number | null;
}

interface NarrativeSessionRow {
  id: string;
  title: string;
  runner: string;
  model: string | null;
  started_at: string;
  turn_count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// HH:MM:SS → ms-of-day (mirrors SessionViewer.hmsToMs so the position label and
// the transcript agree on elapsed time). Returns null when no time is present.
function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

// Whole minutes from the first event to the event at `targetSeq`. The `ts`
// column is wall-clock with no date, so a long run wraps past midnight; walk the
// ordered events and add a day each time the clock goes backwards. Returns null
// when the timestamps can't be parsed or the target isn't found.
function elapsedMinutesToSeq(events: NarrativeEventRow[], targetSeq: number): number | null {
  const firstMs = tsToMs(events[0]?.ts);
  if (firstMs == null) return null;
  let prevMs = firstMs;
  let dayOffset = 0;
  for (const e of events) {
    const cur = tsToMs(e.ts);
    if (cur != null) {
      if (cur < prevMs) dayOffset += DAY_MS; // crossed midnight since the previous event
      prevMs = cur;
    }
    if (e.seq === targetSeq) {
      if (cur == null) return null;
      const elapsed = dayOffset + cur - firstMs;
      return Math.max(0, Math.round(elapsed / 60000));
    }
  }
  return null;
}

// Resolve the現物 (transcript event + short excerpt) for every event/turn
// evidence in one batched pass — never per-evidence (no N+1). Evidence resolves
// either by its subject_id (event id) or by session_id + locator.seq. After the
// excerpt is attached, a SECOND batched pass adds the narrative context
// (session / trigger / position / aftermath) keyed by the resolved (session,seq).
export async function attachEvidenceExcerpts(
  evidence: FindingEvidence[],
  findingKindById: Map<number, FindingKind>,
): Promise<void> {
  const byEventId: FindingEvidence[] = [];
  const bySeq: FindingEvidence[] = [];
  const eventIds = new Set<string>();
  const seqPairs: Array<{ sessionId: string; seq: number }> = [];
  const seenSeqPair = new Set<string>();

  for (const item of evidence) {
    if (item.subjectKind !== 'event' && item.subjectKind !== 'turn') continue;
    if (item.subjectId) {
      byEventId.push(item);
      eventIds.add(item.subjectId);
      continue;
    }
    const seq = locatorSeq(item.locator);
    if (item.sessionId && seq != null) {
      bySeq.push(item);
      const key = `${item.sessionId}\0${seq}`;
      if (!seenSeqPair.has(key)) {
        seenSeqPair.add(key);
        seqPairs.push({ sessionId: item.sessionId, seq });
      }
    }
  }

  if (eventIds.size === 0 && seqPairs.length === 0) return;

  const byId = new Map<string, EvidenceEventRow>();
  const bySessionSeq = new Map<string, EvidenceEventRow>();

  if (eventIds.size > 0) {
    const rows = await queryRows<EvidenceEventRow>(
      `SELECT id, session_id, seq, type, title, command, body, exit_code
         FROM transcript_events
        WHERE id = ANY($1::text[])`,
      [[...eventIds]],
    );
    for (const row of rows) byId.set(row.id, row);
  }

  if (seqPairs.length > 0) {
    const rows = await queryRows<EvidenceEventRow>(
      `SELECT te.id, te.session_id, te.seq, te.type, te.title, te.command, te.body, te.exit_code
         FROM transcript_events te
         JOIN unnest($1::text[], $2::int[]) AS req(session_id, seq)
           ON req.session_id = te.session_id AND req.seq = te.seq`,
      [seqPairs.map((p) => p.sessionId), seqPairs.map((p) => p.seq)],
    );
    for (const row of rows) bySessionSeq.set(`${row.session_id}\0${row.seq}`, row);
  }

  const toExcerpt = (row: EvidenceEventRow): FindingEvidenceExcerpt => ({
    eventId: row.id,
    seq: row.seq,
    type: row.type,
    title: row.title,
    command: truncateExcerpt(row.command),
    output: truncateExcerpt(row.body),
    exitCode: row.exit_code,
    narrative: null,
  });

  // session that each resolved evidence belongs to (from the resolved event row,
  // which always carries session_id even when the evidence row's sessionId was
  // null) — used to drive the narrative pass.
  const targetSessionByEvidence = new Map<number, string>();

  for (const item of byEventId) {
    const row = item.subjectId ? byId.get(item.subjectId) : undefined;
    if (row) {
      item.excerpt = toExcerpt(row);
      targetSessionByEvidence.set(item.id, row.session_id);
    }
  }
  for (const item of bySeq) {
    const seq = locatorSeq(item.locator);
    const row = item.sessionId && seq != null ? bySessionSeq.get(`${item.sessionId}\0${seq}`) : undefined;
    if (row) {
      item.excerpt = toExcerpt(row);
      targetSessionByEvidence.set(item.id, row.session_id);
    }
  }

  await attachEvidenceNarrative(evidence, targetSessionByEvidence, findingKindById);
}

// Second batched pass: for every evidence whose excerpt resolved, attach the
// surrounding story. All transcript_events for the involved sessions are fetched
// ONCE (one query for every session, not one per evidence), then trigger /
// position / aftermath are computed in-process.
async function attachEvidenceNarrative(
  evidence: FindingEvidence[],
  targetSessionByEvidence: Map<number, string>,
  findingKindById: Map<number, FindingKind>,
): Promise<void> {
  if (targetSessionByEvidence.size === 0) return;
  const sessionIds = new Set<string>(targetSessionByEvidence.values());

  const [sessionRows, eventRows] = await Promise.all([
    queryRows<NarrativeSessionRow>(
      `SELECT id, title, runner, model, started_at, turn_count
         FROM sessions
        WHERE id = ANY($1::text[])`,
      [[...sessionIds]],
    ),
    queryRows<NarrativeEventRow>(
      `SELECT session_id, seq, ts, type, title, body, exit_code
         FROM transcript_events
        WHERE session_id = ANY($1::text[])
          AND parent_id IS NULL
        ORDER BY session_id ASC, seq ASC`,
      [[...sessionIds]],
    ),
  ]);

  const sessionById = new Map<string, NarrativeSessionRow>();
  for (const row of sessionRows) sessionById.set(row.id, row);

  const eventsBySession = new Map<string, NarrativeEventRow[]>();
  for (const row of eventRows) {
    const arr = eventsBySession.get(row.session_id);
    if (arr) arr.push(row);
    else eventsBySession.set(row.session_id, [row]);
  }

  for (const item of evidence) {
    if (!item.excerpt) continue;
    const sessionId = targetSessionByEvidence.get(item.id);
    if (!sessionId) continue;
    const session = sessionById.get(sessionId);
    const events = eventsBySession.get(sessionId);
    if (!session || !events) continue;
    const kind = findingKindById.get(item.findingId);
    item.excerpt.narrative = buildNarrative(session, events, item.excerpt.seq, kind);
  }
}

function buildNarrative(
  session: NarrativeSessionRow,
  events: NarrativeEventRow[],
  targetSeq: number,
  kind: FindingKind | undefined,
): FindingEvidenceNarrative {
  // position in the run: 1-based turn (count of user_message at/before target),
  // total turns, and whole minutes from the session's first event to this step.
  let turn: number | null = null;
  let turnSoFar = 0;
  for (const e of events) {
    if (e.type === 'user_message') turnSoFar += 1;
    if (e.seq === targetSeq) {
      turn = turnSoFar > 0 ? turnSoFar : null;
      break;
    }
  }

  // elapsed minutes from the first event to the target. The `ts` column is a
  // wall clock (HH:MM:SS) with no date, so a multi-day run wraps at midnight;
  // accumulate by walking forward and adding a day each time the clock goes
  // backwards, mirroring the transcript's own day-wrap handling.
  const minutesFromStart = elapsedMinutesToSeq(events, targetSeq);

  // trigger: the nearest preceding user_message (the request this stretch of
  // work answers). Falls through to the first user_message of the run.
  let trigger: FindingEvidenceNarrative['trigger'] = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.seq <= targetSeq && e.type === 'user_message') {
      const text = truncateTo(firstLine(e.body) ?? e.title, EVIDENCE_NARRATIVE_CHARS);
      if (text) trigger = { seq: e.seq, text };
      break;
    }
  }

  const aftermath = buildAftermath(events, targetSeq, kind);

  return {
    sessionId: session.id,
    sessionTitle: session.title,
    runner: session.runner,
    model: session.model,
    startedAt: session.started_at,
    turn,
    turnCount: session.turn_count ?? null,
    minutesFromStart,
    trigger,
    aftermath,
  };
}

const FAILURE_TYPES = new Set(['bash', 'test', 'error', 'hook']);

function isFailure(e: NarrativeEventRow): boolean {
  return e.type === 'error' || (e.exit_code != null && e.exit_code !== 0);
}

// "結末" — what the run did after this step. For failure_loop findings we walk to
// the LAST failure in the contiguous run of failures, then take the first
// non-failure event after it (the escape). Otherwise we take the next
// assistant/user message after the target step.
function buildAftermath(
  events: NarrativeEventRow[],
  targetSeq: number,
  kind: FindingKind | undefined,
): FindingEvidenceNarrative['aftermath'] {
  const idx = events.findIndex((e) => e.seq === targetSeq);
  if (idx < 0) return null;

  const summarize = (e: NarrativeEventRow): FindingEvidenceNarrative['aftermath'] => {
    const text = truncateTo(firstLine(e.body) ?? e.title, EVIDENCE_NARRATIVE_CHARS);
    if (!text) return null;
    return { seq: e.seq, type: e.type, text };
  };

  if (kind === 'failure_loop' && FAILURE_TYPES.has(events[idx].type)) {
    // advance through the contiguous block of failing tool calls
    let last = idx;
    for (let i = idx; i < events.length; i += 1) {
      if (isFailure(events[i])) last = i;
      else break;
    }
    // the first non-failure event after the failure block = how it ended
    for (let i = last + 1; i < events.length; i += 1) {
      if (!isFailure(events[i])) return summarize(events[i]);
    }
    // no escape captured — fall back to the last failure itself
    return summarize(events[last]);
  }

  for (let i = idx + 1; i < events.length; i += 1) {
    const e = events[i];
    if (e.type === 'assistant_message' || e.type === 'user_message') return summarize(e);
  }
  // nothing textual after — use the immediate next event if any
  return idx + 1 < events.length ? summarize(events[idx + 1]) : null;
}
