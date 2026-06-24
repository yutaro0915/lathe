import { useMemo } from "react";
import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import type { ChangedFile, DiffHunk, EventType, SessionBundle, TranscriptEvent } from "@/lib/types";
import { Step, type StepEdit } from "./Step";
import { ComparisonList, type ComparisonGroup } from "./ComparisonList";

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
//
// The comparison-list SHELL (rows + expand/collapse + member rendering) is the
// shared ComparisonList component, reused verbatim by SkillsTab (D11: reuse the
// SAME component, do not duplicate). ToolsTab only supplies the aggregation (by
// type) and the per-invocation Step; the `tool-*` data-testids are preserved
// (the slice-7 e2e contract) via the testidPrefix.

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
  // invocation count (descending). Cost / duration are summed per type. The
  // result feeds the shared ComparisonList as generic groups (key = the type).
  const groups = useMemo<ComparisonGroup[]>(() => {
    type Acc = { type: EventType; events: TranscriptEvent[]; count: number; costUsd: number | null; durationMs: number };
    const byType = new Map<EventType, Acc>();
    for (const e of events) {
      if (!TOOL_AGG_SET.has(e.type)) continue;
      let g = byType.get(e.type);
      if (!g) {
        g = { type: e.type, events: [], count: 0, costUsd: null, durationMs: 0 };
        byType.set(e.type, g);
      }
      g.events.push(e);
      g.count += 1;
      g.durationMs += e.durationMs ?? 0;
      const cost = readEventCost(e, bundle);
      if (cost != null) g.costUsd = (g.costUsd ?? 0) + cost;
    }
    return [...byType.values()]
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .map((g) => ({
        key: g.type,
        icon: TYPE_GLYPH[g.type] ?? "•",
        label: g.type,
        labelTitle: EVENT_LABEL[g.type],
        count: g.count,
        costUsd: g.costUsd,
        durationMs: g.durationMs,
        events: g.events,
      }));
  }, [events, bundle]);

  if (groups.length === 0) {
    return (
      <div className="timeline" data-testid="timeline">
        <div className="empty" data-testid="empty" style={{ padding: "var(--sp-16)" }}>
          No tool events.
        </div>
      </div>
    );
  }

  return (
    <ComparisonList
      groups={groups}
      expandedKeys={expandedTypes}
      toggleKey={toggleType}
      eyebrow="Tools · by invocation count"
      hint="Click a row to expand its invocations."
      testidPrefix="tool"
      groupAttr="data-tool-type"
      renderMember={(inv) => (
        // D8: each invocation is the reused single Step component (uniform frame;
        // kind from event.type; error = clean-red state). Clicking a Step expands
        // its detail-block inline.
        <Step
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
      )}
    />
  );
}
