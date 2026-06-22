import { useMemo } from "react";
import { fmtCost, fmtInt, humanizeDuration } from "@lathe/shared";
import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import type { ChangedFile, DiffHunk, EventType, SessionBundle, TranscriptEvent } from "@/lib/types";
import { Step, type StepEdit } from "./Step";

// ToolsTab — D11 comparison-list + D12 inline expansion + D8 single Step.
// THIS session's tool invocations are aggregated BY tool type into one row per
// type, sorted by invocation count (descending). Each row =
//   [neutral type icon][type name, mono][×count][cost · duration, mono][chevron]
// Clicking a type row expands it IN PLACE (chevron-right → chevron-down) to
// reveal that type's invocations, each rendered with the REUSED single Step
// component (D8). There is NO side inspector and NO navigation (D12). Color is
// rationed (D10): the type rows are neutral; the only privileged hue is the
// per-invocation error STATE, carried by Step via var(--c-error). No timestamp
// gutter (D5).

// The event types that count as "tools" (action/tool events) — bash / file_read
// / file_edit / file_write / subagent / test / commit / memory / hook / skill.
// Excludes user_message / assistant_message / thinking (conversation/reasoning,
// not tool invocations). Grounded against EVENT_LABEL (lib/event-display) and
// the prior ToolsTab's TOOL_TYPES notion, widened to the action/tool set.
const TOOL_AGG_TYPES: EventType[] = [
  "bash",
  "file_read",
  "file_edit",
  "file_write",
  "subagent",
  "test",
  "commit",
  "memory",
  "hook",
  "skill",
];
const TOOL_AGG_SET = new Set<EventType>(TOOL_AGG_TYPES);

type ToolTypeGroup = {
  type: EventType;
  invocations: TranscriptEvent[];
  count: number;
  costUsd: number | null;
  durationMs: number;
};

// Per-event cost: a direct meta.costUsd when present, else this event's
// token-proportional share of the session cost (the same derivation the turn
// rollups use, so the Tools totals are consistent with the rest of the viewer).
function readEventCost(e: TranscriptEvent, bundle: SessionBundle): number | null {
  if (e.meta) {
    try {
      const meta = JSON.parse(e.meta);
      if (typeof meta.costUsd === "number") return meta.costUsd;
    } catch {
      /* fall through to token share */
    }
  }
  const { costUsd, tokenUsage } = bundle.session;
  if (costUsd != null && tokenUsage > 0 && e.tokenUsage != null) {
    return (costUsd * e.tokenUsage) / tokenUsage;
  }
  return null;
}

export function ToolsTab({
  bundle,
  expandedTypes,
  toggleType,
  selectedEventId,
  selectEvent,
  expandedAgents,
  toggleAgent,
  editByEventId,
  childrenByParent,
  flashEventId,
}: {
  bundle: SessionBundle;
  expandedTypes: Set<string>;
  toggleType: (type: string) => void;
  selectedEventId?: string;
  selectEvent: (eventId: string) => void;
  expandedAgents: Set<string>;
  toggleAgent: (eventId: string) => void;
  editByEventId: Map<string, { file: ChangedFile; hunks: DiffHunk[] }>;
  childrenByParent: Map<string, TranscriptEvent[]>;
  flashEventId: string | null;
}) {
  const events = bundle.events;
  const resolveEdit = (e: TranscriptEvent): StepEdit => editByEventId.get(e.id) ?? null;

  // Group this session's tool invocations by type, then sort the rows by
  // invocation count (descending). Cost / duration are summed per type.
  const groups = useMemo<ToolTypeGroup[]>(() => {
    const byType = new Map<EventType, ToolTypeGroup>();
    for (const e of events) {
      if (!TOOL_AGG_SET.has(e.type)) continue;
      let g = byType.get(e.type);
      if (!g) {
        g = { type: e.type, invocations: [], count: 0, costUsd: null, durationMs: 0 };
        byType.set(e.type, g);
      }
      g.invocations.push(e);
      g.count += 1;
      g.durationMs += e.durationMs ?? 0;
      const cost = readEventCost(e, bundle);
      if (cost != null) g.costUsd = (g.costUsd ?? 0) + cost;
    }
    return [...byType.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [events, bundle]);

  if (groups.length === 0) {
    return (
      <div className="timeline" data-testid="timeline">
        <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
          No tool events.
        </div>
      </div>
    );
  }

  return (
    <div className="timeline" data-testid="timeline">
      <div className="lds-tools-caption" data-testid="tools-caption">
        <span className="lds-tools-caption-eyebrow">Tools · by invocation count</span>
        <span className="lds-tools-caption-hint">Click a row to expand its invocations.</span>
      </div>
      {/* D11 comparison-list: tool = peer, shared dimension = invocation count.
          Same list shape as Sessions. Row click = inline expand (D12). */}
      <div className="lds-tools-list" data-testid="tools-list">
        {groups.map((g) => {
          const open = expandedTypes.has(g.type);
          return (
            <div
              key={g.type}
              className={`lds-tool-group${open ? " open" : ""}`}
              data-testid="tool-group"
              data-tool-type={g.type}
              data-tool-open={open ? "true" : undefined}
            >
              <div
                className="lds-tool-row"
                data-testid="tool-row"
                data-tool-type={g.type}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleType(g.type)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    toggleType(g.type);
                  }
                }}
              >
                {/* neutral type icon (D4/D10): the glyph, not the colored dot. */}
                <span className="lds-tool-ic" data-testid="tool-ic" aria-hidden>
                  {TYPE_GLYPH[g.type] ?? "•"}
                </span>
                <span className="lds-tool-name" data-testid="tool-name" data-ellipsis-ok title={EVENT_LABEL[g.type]}>
                  {g.type}
                </span>
                <span className="lds-tool-count" data-testid="tool-count">×{fmtInt(g.count)}</span>
                <span className="lds-tool-metric" data-testid="tool-metric">
                  {fmtCost(g.costUsd)} · {humanizeDuration(g.durationMs > 0 ? g.durationMs : null)}
                </span>
                <span className="lds-tool-chevron" data-testid="tool-chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              </div>

              {open && (
                <div className="lds-tool-body" data-testid="tool-body">
                  {/* D8: each invocation is the reused single Step component
                      (uniform frame; kind from event.type; error = clean-red
                      state). Clicking a Step expands its detail-block inline. */}
                  {g.invocations.map((inv) => (
                    <Step
                      key={inv.id}
                      event={inv}
                      depth={1}
                      selectedEventId={selectedEventId}
                      flashEventId={flashEventId}
                      childSteps={childrenByParent.get(inv.id) ?? []}
                      agentExpanded={expandedAgents.has(inv.id)}
                      onToggleAgent={toggleAgent}
                      edit={resolveEdit(inv)}
                      resolveEdit={resolveEdit}
                      onSelect={selectEvent}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
