import { EVENT_LABEL } from "@/lib/event-display";
import type { EventType, TranscriptEvent } from "@/lib/types";
import type { FilterMode, TurnRollup } from "./types";
import { ALL_TYPES } from "./types";
import { EventRow } from "./EventRow";

type Props = {
  transcriptSearch: string;
  setTranscriptSearch: (value: string) => void;
  turnCount: number;
  collapsedTurns: Set<string>;
  expandAllTurns: () => void;
  collapseAllTurns: () => void;
  typeFilter: Set<EventType>;
  toggleType: (type: EventType) => void;
  typeCounts: Partial<Record<EventType, number>>;
  filterMode: FilterMode;
  setFilterMode: (mode: FilterMode) => void;
  visibleEvents: TranscriptEvent[];
  childrenByParent: Map<string, TranscriptEvent[]>;
  shouldRenderTimelineEvent: (event: TranscriptEvent) => boolean;
  turnHeaderIds: Map<string, string>;
  turnNumberByEventId: Map<string, number>;
  turnRollups: Map<string, Omit<TurnRollup, "collapsed">>;
  selectedEventId?: string;
  flashEventId: string | null;
  pins: Set<string>;
  notes: Record<string, string>;
  expandedAgents: Set<string>;
  matchesType: (event: TranscriptEvent) => boolean;
  eventTimeBars: Map<string, { startPct: number; widthPct: number }>;
  commitLabel: string;
  selectTimelineEvent: (eventId: string, expandTurn?: boolean) => void;
  setSelectedEventId: (eventId: string) => void;
  toggleTurn: (headerId: string) => void;
  toggleAgent: (eventId: string) => void;
  openAgent: (launcherId: string) => void;
  openTurnFile: (fileId: string) => void;
};

export function TranscriptTab({
  transcriptSearch,
  setTranscriptSearch,
  turnCount,
  collapsedTurns,
  expandAllTurns,
  collapseAllTurns,
  typeFilter,
  toggleType,
  typeCounts,
  filterMode,
  setFilterMode,
  visibleEvents,
  childrenByParent,
  shouldRenderTimelineEvent,
  turnHeaderIds,
  turnNumberByEventId,
  turnRollups,
  selectedEventId,
  flashEventId,
  pins,
  notes,
  expandedAgents,
  matchesType,
  eventTimeBars,
  commitLabel,
  selectTimelineEvent,
  setSelectedEventId,
  toggleTurn,
  toggleAgent,
  openAgent,
  openTurnFile,
}: Props) {
  const rows = [];
  for (const e of visibleEvents) {
    const header = turnHeaderIds.get(e.id);
    const isHeader = e.type === "user_message" && turnNumberByEventId.has(e.id);
    const collapsed = header != null && collapsedTurns.has(header);
    if (collapsed && !isHeader) continue;
    const kids = childrenByParent.get(e.id) ?? [];
    const rollup = isHeader ? turnRollups.get(e.id) : undefined;
    const turnStats = rollup ? { ...rollup, collapsed } : undefined;
    rows.push(
      <EventRow
        key={e.id}
        e={e}
        depth={0}
        childCount={kids.length}
        turnStats={turnStats}
        selectedEventId={selectedEventId}
        flashEventId={flashEventId}
        pins={pins}
        notes={notes}
        expandedAgents={expandedAgents}
        filterMode={filterMode}
        matchesType={matchesType}
        eventTimeBars={eventTimeBars}
        turnHeaderIds={turnHeaderIds}
        turnRollups={turnRollups}
        turnCount={turnCount}
        commitLabel={commitLabel}
        onSelect={selectTimelineEvent}
        onSetSelected={setSelectedEventId}
        onToggleTurn={toggleTurn}
        onToggleAgent={toggleAgent}
        onOpenAgent={openAgent}
        onOpenTurnFile={openTurnFile}
      />,
    );
    if (!isHeader && kids.length && expandedAgents.has(e.id)) {
      for (const k of kids) {
        if (shouldRenderTimelineEvent(k)) {
          rows.push(
            <EventRow
              key={k.id}
              e={k}
              depth={1}
              childCount={0}
              selectedEventId={selectedEventId}
              flashEventId={flashEventId}
              pins={pins}
              notes={notes}
              expandedAgents={expandedAgents}
              filterMode={filterMode}
              matchesType={matchesType}
              eventTimeBars={eventTimeBars}
              turnHeaderIds={turnHeaderIds}
              turnRollups={turnRollups}
              turnCount={turnCount}
              commitLabel={commitLabel}
              onSelect={selectTimelineEvent}
              onSetSelected={setSelectedEventId}
              onToggleTurn={toggleTurn}
              onToggleAgent={toggleAgent}
              onOpenAgent={openAgent}
              onOpenTurnFile={openTurnFile}
            />,
          );
        }
      }
    }
  }

  return (
    <>
      <div className="transcript-toolbar" data-testid="transcript-toolbar">
        <div className="transcript-toolbar-row" data-testid="transcript-toolbar-row" style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 12px 6px" }}>
          <div className="search" data-testid="search" style={{ flex: "1 1 auto" }}>
            <span aria-hidden>⌕</span>
            <input placeholder="Filter timeline…" value={transcriptSearch} onChange={(e) => setTranscriptSearch(e.target.value)} />
          </div>
          {turnCount > 1 && (
            <span className="segmented turn-filter" data-testid="turn-filter" title="Show/hide every turn in this session">
              <button type="button" className={collapsedTurns.size === 0 ? "active" : ""} onClick={expandAllTurns}>
                Expand turns
              </button>
              <button type="button" className={collapsedTurns.size === turnCount ? "active" : ""} onClick={collapseAllTurns}>
                Collapse turns
              </button>
            </span>
          )}
        </div>
        <div className="filters transcript-filters" data-testid="transcript-filters">
          <div className="filter-row" data-testid="filter-row">
            <span className="flabel" data-testid="flabel">Event types</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {ALL_TYPES.map((t) => {
                const on = typeFilter.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`event-type-badge ${t}`}
                    data-testid="event-type-badge"
                    data-event-kind={t}
                    title={`${EVENT_LABEL[t]} — click to ${on ? "hide" : "show"}`}
                    onClick={() => toggleType(t)}
                    style={{ cursor: "pointer", opacity: on ? 1 : 0.38 }}
                  >
                    {EVENT_LABEL[t]}
                    <span className="mono" data-testid="mono" style={{ marginLeft: "auto", color: "var(--muted-2)" }}>
                      {typeCounts[t] ?? 0}
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="segmented filter-mode" data-testid="filter-mode" style={{ marginLeft: "auto" }} title="Choose whether non-matching event types stay visible (dimmed) or are hidden">
              <button type="button" className={filterMode === "highlight" ? "active" : ""} onClick={() => setFilterMode("highlight")}>
                Highlight
              </button>
              <button type="button" className={filterMode === "hide" ? "active" : ""} onClick={() => setFilterMode("hide")}>
                Hide
              </button>
            </span>
          </div>
        </div>
      </div>
      <div className="timeline" data-testid="timeline">
        {rows}
        {visibleEvents.length === 0 && (
          <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
            No events match the current filters.
          </div>
        )}
      </div>
    </>
  );
}
