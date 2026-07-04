import { useMemo } from "react";
import type { Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import { kindOf } from "@/lib/event-display";
import type { StepKind } from "@/lib/event-display";
import { buildEditByEventId } from "./edit-map";

// useSessionDerivedData — all pure-memo derived values that the SessionViewer
// wires together. Extracted from SessionViewer (file-size I4).
export function useSessionDerivedData({
  events,
  sessions,
  bundle,
  transcriptSearch,
}: {
  events: TranscriptEvent[];
  sessions: Session[];
  bundle: SessionBundle;
  transcriptSearch: string;
}) {
  const seedId = useMemo(() => {
    const first = events.find((e) => !e.parentId) ?? events[0];
    return first?.id;
  }, [events]);

  const childrenByParent = useMemo(() => {
    const m = new Map<string, TranscriptEvent[]>();
    for (const e of events) {
      if (e.parentId) {
        const arr = m.get(e.parentId);
        if (arr) arr.push(e);
        else m.set(e.parentId, [e]);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => a.seq - b.seq);
    return m;
  }, [events]);

  const sessionById = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const invocations = useMemo(
    () => events.filter((e) => e.type === "subagent" && !e.parentId),
    [events],
  );

  const eventsWithDiff = useMemo(() => {
    const s = new Set<string>();
    for (const hunkList of Object.values(bundle.hunks)) {
      for (const h of hunkList) {
        for (const a of bundle.attributions[h.id] ?? []) if (a.eventId) s.add(a.eventId);
      }
    }
    return s;
  }, [bundle.hunks, bundle.attributions]);

  const matchesSearch = useMemo(() => {
    const q = transcriptSearch.trim().toLowerCase();
    return (e: TranscriptEvent) => {
      if (!q) return true;
      const hay = `${e.title} ${e.command ?? ""} ${e.filePath ?? ""} ${e.body ?? ""}`.toLowerCase();
      return hay.includes(q);
    };
  }, [transcriptSearch]);

  const topEvents = useMemo(() => events.filter((e) => !e.parentId), [events]);

  const stepCount = useMemo(
    () => topEvents.filter((e) => e.type !== "user_message").length,
    [topEvents],
  );

  const { turnNumberByEventId, turnHeaderIds } = useMemo(() => {
    const turnNumberByEventId = new Map<string, number>();
    const turnHeaderIds = new Map<string, string>();
    let n = 0;
    let header: string | null = null;
    for (const e of topEvents) {
      if (e.type === "user_message") {
        n += 1;
        header = e.id;
        turnNumberByEventId.set(e.id, n);
      }
      if (header) turnHeaderIds.set(e.id, header);
    }
    return { turnNumberByEventId, turnHeaderIds };
  }, [topEvents]);

  const turnHeaders = useMemo(
    () => topEvents.filter((e) => e.type === "user_message"),
    [topEvents],
  );

  const stepsByTurn = useMemo(() => {
    const m = new Map<string, TranscriptEvent[]>();
    for (const header of turnHeaders) m.set(header.id, []);
    for (const e of topEvents) {
      const headerId = turnHeaderIds.get(e.id);
      if (!headerId || e.id === headerId) continue; // skip orphans + the header itself
      m.get(headerId)?.push(e);
    }
    return m;
  }, [topEvents, turnHeaders, turnHeaderIds]);

  const kindCounts = useMemo(() => {
    const counts: Partial<Record<StepKind, number>> = {};
    for (const e of events) {
      if (e.type === "user_message") continue;
      const k = kindOf(e.type);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  }, [events]);

  const editByEventId = useMemo(
    () => buildEditByEventId(bundle, events),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle.attributions, bundle.changedFiles, bundle.hunks, events, bundle],
  );

  return {
    seedId,
    childrenByParent,
    sessionById,
    invocations,
    eventsWithDiff,
    matchesSearch,
    topEvents,
    stepCount,
    turnNumberByEventId,
    turnHeaderIds,
    turnHeaders,
    stepsByTurn,
    kindCounts,
    editByEventId,
  };
}
