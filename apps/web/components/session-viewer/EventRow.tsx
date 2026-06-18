import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import { fmtCompact, fmtCost, humanizeDuration } from "@lathe/shared";
import type { EventType, TranscriptEvent } from "@/lib/types";
import type { FilterMode, TurnRollup } from "./types";

type Props = {
  e: TranscriptEvent;
  depth: number;
  childCount: number;
  turnStats?: TurnRollup;
  selectedEventId?: string;
  flashEventId: string | null;
  pins: Set<string>;
  notes: Record<string, string>;
  expandedAgents: Set<string>;
  filterMode: FilterMode;
  matchesType: (e: TranscriptEvent) => boolean;
  eventTimeBars: Map<string, { startPct: number; widthPct: number }>;
  turnHeaderIds: Map<string, string>;
  turnRollups: Map<string, Omit<TurnRollup, "collapsed">>;
  turnCount: number;
  commitLabel: string;
  onSelect: (eventId: string, expandTurn?: boolean) => void;
  onSetSelected: (eventId: string) => void;
  onToggleTurn: (headerId: string) => void;
  onToggleAgent: (eventId: string) => void;
  onOpenAgent: (launcherId: string) => void;
  onOpenTurnFile: (fileId: string) => void;
};

export function EventRow({
  e,
  depth,
  childCount,
  turnStats,
  selectedEventId,
  flashEventId,
  pins,
  notes,
  expandedAgents,
  filterMode,
  matchesType,
  eventTimeBars,
  turnHeaderIds,
  turnRollups,
  turnCount,
  commitLabel,
  onSelect,
  onSetSelected,
  onToggleTurn,
  onToggleAgent,
  onOpenAgent,
  onOpenTurnFile,
}: Props) {
  const isSel = selectedEventId === e.id;
  const glyph = TYPE_GLYPH[e.type] ?? "•";
  const pinned = pins.has(e.id);
  const expanded = expandedAgents.has(e.id);
  const isTurnHeader = turnStats != null;
  const ownerHeaderId = turnHeaderIds.get(e.id);
  const ownerTurn = isTurnHeader ? turnStats.turn : ownerHeaderId ? turnRollups.get(ownerHeaderId)?.turn : undefined;
  const rollupDurationMs =
    isTurnHeader && turnStats.durationMs > 0 ? turnStats.durationMs : isTurnHeader ? turnStats.wallDurationMs : 0;
  const isDimmed = filterMode === "highlight" && !matchesType(e);
  const timebar = eventTimeBars.get(e.id) ?? { startPct: 0, widthPct: 0.35 };
  const showBadge = showEventBadge(e.type);
  const handleActivate = () => {
    if (isTurnHeader) {
      onSetSelected(e.id);
      onToggleTurn(e.id);
    } else {
      onSelect(e.id);
    }
  };

  return (
    <div
      key={e.id}
      data-eid={e.id}
      data-filter-match={isDimmed ? "false" : "true"}
      data-turn={ownerTurn}
      data-rollup-steps={isTurnHeader ? turnStats.steps : undefined}
      data-rollup-edits={isTurnHeader ? turnStats.edits : undefined}
      data-rollup-errors={isTurnHeader ? turnStats.errors : undefined}
      data-rollup-files={isTurnHeader ? turnStats.files.length : undefined}
      data-rollup-duration-ms={isTurnHeader ? rollupDurationMs : undefined}
      data-turn-has-error={isTurnHeader && turnStats.errors > 0 ? "true" : undefined}
      data-flash={flashEventId === e.id ? "true" : undefined}
      data-selected={isSel ? "true" : undefined}
      data-row-kind={isTurnHeader ? "turn-header" : "step"}
      data-child-row={depth > 0 ? "true" : undefined}
      data-dimmed={isDimmed ? "true" : undefined}
      className={`event-row${depth > 0 ? " child-row" : ""}${!isTurnHeader ? " step-row" : ""}${isSel ? " selected" : ""}${flashEventId === e.id ? " flash-jump" : ""}${isTurnHeader ? " turn-header" : ""}${isTurnHeader && turnStats.errors > 0 ? " turn-has-error" : ""}${isDimmed ? " filter-dimmed" : ""}`}
      data-testid="event-row"
      onClick={handleActivate}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          handleActivate();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <span className="event-seq" data-testid="event-seq">
        {isTurnHeader ? (
          <button
            type="button"
            className="tw-expand"
            data-testid="tw-expand"
            aria-label={turnStats.collapsed ? "Expand turn" : "Collapse turn"}
            title={turnStats.collapsed ? "Expand this turn" : "Collapse this turn"}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggleTurn(e.id);
            }}
          >
            {turnStats.collapsed ? "▸" : "▾"}
          </button>
        ) : childCount > 0 ? (
          <button
            type="button"
            className="tw-expand"
            data-testid="tw-expand"
            aria-label={expanded ? "Collapse sub-agent" : "Expand sub-agent"}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggleAgent(e.id);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : depth > 0 ? (
          ""
        ) : (
          e.seq
        )}
      </span>
      <span className="event-gutter" data-testid="event-gutter">{e.ts}</span>
      <span className={`event-icon ${e.type}`} data-testid="event-icon" data-event-kind={e.type} aria-hidden>
        {glyph}
      </span>
      <div className="event-main" data-testid="event-main">
        <div className="event-headline" data-testid="event-headline">
          {isTurnHeader && (
            <span className="chip turn-chip" data-testid="chip" data-chip-kind="turn" title={`Turn ${turnStats.turn} of ${turnCount}`}>
              Turn {turnStats.turn}
            </span>
          )}
          <span className="event-title" data-testid="event-title">{e.title}</span>
          {pinned && <span title="Pinned" aria-label="Pinned">📌</span>}
          {notes[e.id] && <span title="Has note" aria-label="Has note">🗒</span>}
          {showBadge && (
            <span className={`event-type-badge ${e.type}`} data-testid="event-type-badge" data-event-kind={e.type}>
              {EVENT_LABEL[e.type]}
            </span>
          )}
          {depth === 0 && e.subagent && (
            <span className="event-type-badge subagent" data-testid="event-type-badge" data-event-kind="subagent">{e.subagent}</span>
          )}
        </div>
        {isTurnHeader ? (
          // One tidy rollup line (no piled chip-grid). The e2e contract reads the
          // rollup numbers off the row text + the data-rollup-* attributes, so the
          // values stay; only the bordered-chip stacking goes. The files entry is a
          // clickable chip (data-file-id) — the "turn files chip" test clicks it.
          <div className="event-sub turn-rollup-line" data-testid="event-sub">
            <span className="trl-seg" data-rollup-kind="steps">
              {turnStats.steps} step{turnStats.steps === 1 ? "" : "s"}
            </span>
            <span className="trl-sep" aria-hidden>·</span>
            <span className="trl-seg" data-rollup-kind="edits">{turnStats.edits} edits</span>
            <span className="trl-sep" aria-hidden>·</span>
            <span className={`trl-seg${turnStats.errors > 0 ? " err" : ""}`} data-rollup-kind="errors">
              {turnStats.errors} errors
            </span>
            <span className="trl-sep" aria-hidden>·</span>
            <span className="trl-seg" data-rollup-kind="cost">{fmtCost(turnStats.costUsd)}</span>
            <span className="trl-sep" aria-hidden>·</span>
            <span className="trl-seg" data-rollup-kind="tokens">{fmtCompact(turnStats.tokens)} tok</span>
            <span className="trl-sep" aria-hidden>·</span>
            <span className="trl-seg" data-rollup-kind="duration">{humanizeDuration(rollupDurationMs)}</span>
            <span className="trl-sep" aria-hidden>·</span>
            {turnStats.files.length > 0 ? (
              <button
                type="button"
                className="chip turn-files-chip"
                data-testid="chip"
                data-file-id={turnStats.files[0].id}
                title={turnStats.files.map((f) => f.path).join("\n")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenTurnFile(turnStats.files[0].id);
                }}
              >
                {turnStats.files.length} files
              </button>
            ) : (
              <span className="trl-seg is-empty" data-rollup-kind="files">0 files</span>
            )}
          </div>
        ) : (
          // Step rows are NAVIGATION only: the title gets the room. The dense per-
          // event facts (diff stat, latency, exit, tokens, paths, I/O) live in the
          // wide detail pane — they are intentionally NOT repeated in this list.
          // The proportional step-timebar stays as a thin inline latency signal.
          <span
            className="step-timebar-track"
            data-testid="step-timebar-track"
            title={`time ${timebar.startPct.toFixed(1)}% · duration ${e.durationMs ?? 0}ms`}
          >
            <span
              className="step-timebar"
              data-testid="step-timebar"
              data-start-pct={timebar.startPct.toFixed(3)}
              data-width-pct={timebar.widthPct.toFixed(3)}
              data-duration-ms={e.durationMs ?? 0}
              style={{ left: `${timebar.startPct}%`, width: `${timebar.widthPct}%` }}
            />
          </span>
        )}
      </div>
      <span className="event-meta" data-testid="event-meta">
        {childCount > 0 && <span className="chip" data-testid="chip">{childCount} steps</span>}
        {depth === 0 && e.type === "subagent" && (
          <button
            type="button"
            className="sa-jump"
            data-testid="sa-jump"
            title="Open this run in the Subagents tab"
            onClick={(ev) => {
              ev.stopPropagation();
              onOpenAgent(e.id);
            }}
          >
            ⌥ open →
          </button>
        )}
        {e.type === "commit" && <span className="chip hash" data-testid="chip">{commitLabel}</span>}
        {e.exitCode != null && (e.exitCode === 0 ? <span className="ok" data-testid="ok">✓</span> : <span className="err" data-testid="err">✗</span>)}
      </span>
    </div>
  );
}

function showEventBadge(type: EventType): boolean {
  return (
    type === "subagent" ||
    type === "skill" ||
    type === "error" ||
    type === "commit" ||
    type === "thinking" ||
    type === "memory" ||
    type === "hook"
  );
}
