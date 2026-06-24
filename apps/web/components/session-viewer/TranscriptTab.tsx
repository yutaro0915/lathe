import { KIND_GLYPH, KIND_LABEL, kindOf, type StepKind } from "@/lib/event-display";
import type { ChangedFile, DiffHunk, TranscriptEvent } from "@/lib/types";
import { Pressable, SearchInput } from "@/design-system/components";
import type { FilterMode, TurnRollup } from "./types";
import { ALL_KINDS } from "./types";
import { Step, type StepEdit } from "./Step";

// Pressable is DS Pressable for bespoke controls; feature classes keep their visuals.

// TranscriptTab — D6 inline turn-accordion. The whole transcript is a stack of
// bordered turn cards (all collapsed by default = whole-session overview).
// Clicking a turn header expands ONLY that turn, revealing its steps inline as
// uniform Step components (D8). There is NO side detail pane. A step expands its
// own detail-block inline (handled inside Step). The toolbar keeps text search +
// the kind filter (D7's 5 kinds, the successor of the old event-type filter).

type Props = {
  transcriptSearch: string;
  setTranscriptSearch: (value: string) => void;
  // turn model
  turnCount: number;
  collapsedTurns: Set<string>;
  expandAllTurns: () => void;
  collapseAllTurns: () => void;
  toggleTurn: (headerId: string) => void;
  turnHeaders: TranscriptEvent[]; // user_message events that head each turn, in order
  turnNumberByEventId: Map<string, number>;
  turnRollups: Map<string, Omit<TurnRollup, "collapsed">>;
  stepsByTurn: Map<string, TranscriptEvent[]>; // top-level steps under each turn header
  childrenByParent: Map<string, TranscriptEvent[]>;
  // kind filter (D7) — successor of the event-type filter
  kindFilter: Set<StepKind>;
  toggleKind: (kind: StepKind) => void;
  kindCounts: Partial<Record<StepKind, number>>;
  filterMode: FilterMode;
  setFilterMode: (mode: FilterMode) => void;
  // step interaction
  selectedEventId?: string;
  flashEventId: string | null;
  expandedAgents: Set<string>;
  toggleAgent: (eventId: string) => void;
  selectStep: (eventId: string) => void;
  // edit detail-block resolution
  editByEventId: Map<string, { file: ChangedFile; hunks: DiffHunk[] }>;
  matchesSearch: (event: TranscriptEvent) => boolean;
};

export function TranscriptTab({
  transcriptSearch,
  setTranscriptSearch,
  turnCount,
  collapsedTurns,
  expandAllTurns,
  collapseAllTurns,
  toggleTurn,
  turnHeaders,
  turnNumberByEventId,
  turnRollups,
  stepsByTurn,
  childrenByParent,
  kindFilter,
  toggleKind,
  kindCounts,
  filterMode,
  setFilterMode,
  selectedEventId,
  flashEventId,
  expandedAgents,
  toggleAgent,
  selectStep,
  editByEventId,
  matchesSearch,
}: Props) {
  const resolveEdit = (e: TranscriptEvent): StepEdit => editByEventId.get(e.id) ?? null;
  // A step is shown when it matches search AND (in hide mode) its kind is on.
  const stepVisible = (e: TranscriptEvent): boolean =>
    matchesSearch(e) && (filterMode === "highlight" || kindFilter.has(kindOf(e.type)));
  const stepDimmed = (e: TranscriptEvent): boolean =>
    filterMode === "highlight" && !kindFilter.has(kindOf(e.type));

  return (
    <>
      <div className="transcript-toolbar" data-testid="transcript-toolbar">
        <div className="transcript-toolbar-row" data-testid="transcript-toolbar-row" style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 12px 6px" }}>
          <div data-testid="search" style={{ flex: "1 1 auto", minWidth: 0 }}>
            <SearchInput
              className="search"
              placeholder="Filter timeline…"
              value={transcriptSearch}
              onChange={(e) => setTranscriptSearch(e.target.value)}
              aria-label="Filter timeline"
            />
          </div>
          {turnCount > 1 && (
            <span className="segmented turn-filter" data-testid="turn-filter" title="Expand or collapse every turn in this session">
              <Pressable type="button" className={collapsedTurns.size === 0 ? "active" : ""} onClick={expandAllTurns}>
                Expand turns
              </Pressable>
              <Pressable type="button" className={collapsedTurns.size === turnCount ? "active" : ""} onClick={collapseAllTurns}>
                Collapse turns
              </Pressable>
            </span>
          )}
        </div>
        <div className="filters transcript-filters" data-testid="transcript-filters">
          <div className="filter-row" data-testid="filter-row">
            <span className="flabel" data-testid="flabel">Step kinds</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {ALL_KINDS.map((k) => {
                const on = kindFilter.has(k);
                return (
                  <Pressable
                    key={k}
                    type="button"
                    className="event-type-badge"
                    data-testid="kind-badge"
                    data-step-kind={k}
                    title={`${KIND_LABEL[k]} — click to ${on ? "hide" : "show"}`}
                    onClick={() => toggleKind(k)}
                    style={{ cursor: "pointer", opacity: on ? 1 : 0.38 }}
                  >
                    <span className={`event-icon ${kindIconType(k)}`} data-step-kind={k} aria-hidden style={{ marginRight: 4 }}>{KIND_GLYPH[k]}</span>
                    {KIND_LABEL[k]}
                    <span className="mono" data-testid="mono" style={{ marginLeft: "auto", color: "var(--muted-2)" }}>
                      {kindCounts[k] ?? 0}
                    </span>
                  </Pressable>
                );
              })}
            </div>
            <span className="segmented filter-mode" data-testid="filter-mode" style={{ marginLeft: "auto" }} title="Choose whether non-matching step kinds stay visible (dimmed) or are hidden">
              <Pressable type="button" className={filterMode === "highlight" ? "active" : ""} onClick={() => setFilterMode("highlight")}>
                Highlight
              </Pressable>
              <Pressable type="button" className={filterMode === "hide" ? "active" : ""} onClick={() => setFilterMode("hide")}>
                Hide
              </Pressable>
            </span>
          </div>
        </div>
      </div>

      <div className="timeline lds-tx-accordion" data-testid="timeline">
        {turnHeaders.map((header) => {
          const turn = turnNumberByEventId.get(header.id) ?? 0;
          const rollup = turnRollups.get(header.id);
          const collapsed = collapsedTurns.has(header.id);
          const steps = stepsByTurn.get(header.id) ?? [];
          const visibleSteps = steps.filter(stepVisible);
          const hasError = (rollup?.errors ?? 0) > 0;
          return (
            <div
              key={header.id}
              data-eid={header.id}
              data-testid="event-row"
              data-row-kind="turn-header"
              data-turn={turn}
              data-rollup-steps={rollup?.steps}
              data-rollup-edits={rollup?.edits}
              data-rollup-errors={rollup?.errors}
              data-rollup-files={rollup?.files.length}
              data-turn-has-error={hasError ? "true" : undefined}
              data-selected={selectedEventId === header.id ? "true" : undefined}
              className={`lds-turn-card${collapsed ? "" : " open"}${hasError ? " turn-has-error" : ""}${selectedEventId === header.id ? " selected" : ""}`}
            >
              <div
                className="lds-turn-head"
                data-testid="turn-head"
                role="button"
                tabIndex={0}
                onClick={() => toggleTurn(header.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    toggleTurn(header.id);
                  }
                }}
              >
                <Pressable
                  type="button"
                  className="tw-expand"
                  data-testid="tw-expand"
                  aria-label={collapsed ? "Expand turn" : "Collapse turn"}
                  aria-expanded={!collapsed}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleTurn(header.id);
                  }}
                >
                  {collapsed ? "▸" : "▾"}
                </Pressable>
                <span className="lds-turn-n" data-testid="chip" data-chip-kind="turn" title={`Turn ${turn} of ${turnCount}`}>
                  Turn {turn}
                </span>
                {/* turn summary intentionally ellipsizes; title carries the full text. */}
                <span className="lds-turn-summary" data-testid="turn-summary" data-ellipsis-ok title={rollup?.summary}>
                  {rollup?.summary}
                </span>
                <span className="lds-turn-steps" data-testid="turn-steps">
                  {rollup?.steps ?? 0} step{(rollup?.steps ?? 0) === 1 ? "" : "s"}
                </span>
              </div>

              {!collapsed && (
                <div className="lds-turn-body" data-testid="turn-body">
                  {visibleSteps.length === 0 ? (
                    <div className="empty lds-step-empty" data-testid="empty">No steps match the current filters.</div>
                  ) : (
                    visibleSteps.map((step) => {
                      const kids = childrenByParent.get(step.id) ?? [];
                      const dimmed = stepDimmed(step);
                      return (
                        <div key={step.id} className={dimmed ? "lds-step-dim" : undefined} data-dimmed={dimmed ? "true" : undefined} data-turn={turn}>
                          <Step
                            event={step}
                            depth={0}
                            turn={turn}
                            selectedEventId={selectedEventId}
                            flashEventId={flashEventId}
                            childSteps={kids}
                            agentExpanded={expandedAgents.has(step.id)}
                            onToggleAgent={toggleAgent}
                            edit={resolveEdit(step)}
                            resolveEdit={resolveEdit}
                            onSelect={selectStep}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
        {turnHeaders.length === 0 && (
          <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
            No turns in this session.
          </div>
        )}
      </div>
    </>
  );
}

// the kind dot reuses the existing .event-icon.<type> color tokens; map each
// kind to a representative event type so the dot picks up the right hue (D4/D10).
function kindIconType(kind: StepKind): string {
  switch (kind) {
    case "thinking":
      return "thinking";
    case "investigate":
      return "file_read";
    case "execute":
      return "bash";
    case "edit":
      return "file_edit";
    case "message":
      return "assistant_message";
  }
}
