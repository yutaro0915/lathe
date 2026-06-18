import type { TranscriptEvent } from "@/lib/types";
import { TOOL_TYPES } from "./types";
import { SimpleEventRow } from "./SimpleEventRow";

export function ToolsTab({
  events,
  selectedEventId,
  setSelectedEventId,
}: {
  events: TranscriptEvent[];
  selectedEventId?: string;
  setSelectedEventId: (eventId: string) => void;
}) {
  const toolEvents = events.filter((e) => TOOL_TYPES.includes(e.type));
  return (
    <div className="timeline" data-testid="timeline">
      {toolEvents.map((e) => (
        <SimpleEventRow key={e.id} event={e} selected={selectedEventId === e.id} onSelect={setSelectedEventId} />
      ))}
      {toolEvents.length === 0 && (
        <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
          No tool events.
        </div>
      )}
    </div>
  );
}
