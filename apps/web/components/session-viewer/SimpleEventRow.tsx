import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import type { TranscriptEvent } from "@/lib/types";
import { durLabel } from "./types";

type Props = {
  event: TranscriptEvent;
  selected: boolean;
  child?: boolean;
  label?: string;
  onSelect: (eventId: string) => void;
};

export function SimpleEventRow({ event, selected, child = false, label, onSelect }: Props) {
  const activate = () => onSelect(event.id);
  return (
    <div
      key={event.id}
      data-eid={child ? undefined : event.id}
      data-selected={selected ? "true" : undefined}
      data-child-row={child ? "true" : undefined}
      data-event-kind={event.type}
      className={`event-row${child ? " child-row" : ""}${selected ? " selected" : ""}`}
      data-testid="event-row"
      onClick={activate}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <span className="event-seq" data-testid="event-seq">{event.seq}</span>
      <span className="event-gutter" data-testid="event-gutter">{event.ts}</span>
      <span className={`event-icon ${event.type}`} data-testid="event-icon" data-event-kind={event.type} aria-hidden>
        {TYPE_GLYPH[event.type] ?? "•"}
      </span>
      <div className="event-main" data-testid="event-main">
        <div className="event-headline" data-testid="event-headline">
          {/* compact-list title intentionally ellipsizes — see EventRow.tsx. */}
          <span className="event-title" data-testid="event-title" data-ellipsis-ok>{event.title}</span>
          <span className={`event-type-badge ${event.type}`} data-testid="event-type-badge" data-event-kind={event.type}>
            {label ?? EVENT_LABEL[event.type]}
          </span>
        </div>
        {event.command ? (
          <div className="event-sub mono" data-testid="event-sub">{event.command}</div>
        ) : event.filePath ? (
          <div className="event-sub path" data-testid="event-sub">{event.filePath}</div>
        ) : event.body ? (
          <div className="event-sub body" data-testid="event-sub">{event.body.split("\n")[0]}</div>
        ) : null}
      </div>
      <span className="event-meta" data-testid="event-meta">
        {event.durationMs != null && <span className="dur" data-testid="dur">{durLabel(event.durationMs)}</span>}
        {event.exitCode != null &&
          (event.exitCode === 0 ? (
            <span className="ok" data-testid="ok">{child ? "✓" : "exit 0 ✓"}</span>
          ) : (
            <span className="err" data-testid="err">{child ? "✗" : `exit ${event.exitCode} ✗`}</span>
          ))}
      </span>
    </div>
  );
}
