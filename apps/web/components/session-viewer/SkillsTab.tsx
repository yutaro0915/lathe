import type { TranscriptEvent } from "@/lib/types";
import { SimpleEventRow } from "./SimpleEventRow";

export function SkillsTab({
  events,
  selectedEventId,
  setSelectedEventId,
}: {
  events: TranscriptEvent[];
  selectedEventId?: string;
  setSelectedEventId: (eventId: string) => void;
}) {
  const skillEvents = events.filter((e) => e.type === "skill");
  return (
    <div className="timeline" data-testid="timeline">
      {skillEvents.map((e) => (
        <SimpleEventRow key={e.id} event={e} selected={selectedEventId === e.id} label="Skill" onSelect={setSelectedEventId} />
      ))}
      {skillEvents.length === 0 && (
        <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
          No skill events.
        </div>
      )}
    </div>
  );
}
