import { useMemo } from "react";
import type { TranscriptEvent } from "@/lib/types";

// useEventLookups — the two event lookup maps the viewer uses for deep-link /
// evidence resolution: by id, and by seq (top-level events win the seq slot, then
// any event fills a still-empty seq). Extracted from SessionViewer (file-size I4).
export function useEventLookups(events: TranscriptEvent[]) {
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const eventBySeq = useMemo(() => {
    const map = new Map<number, TranscriptEvent>();
    for (const event of events) {
      if (!event.parentId && !map.has(event.seq)) map.set(event.seq, event);
      if (!map.has(event.seq)) map.set(event.seq, event);
    }
    return map;
  }, [events]);
  return { eventById, eventBySeq };
}
