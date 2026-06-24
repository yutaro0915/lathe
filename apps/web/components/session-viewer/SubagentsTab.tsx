import { useMemo, useState } from "react";
import { fmtCost, fmtInt } from "@lathe/shared";
import type { ChangedFile, DiffHunk, Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import { Segmented } from "@/design-system/components";
import { ComparisonList, type ComparisonGroup } from "./ComparisonList";
import { NestedMiniSession } from "./NestedMiniSession";
import { SubagentByStep } from "./SubagentByStep";
import {
  groupLaunchersByStep,
  launcherStats,
  subagentName,
  summarizeInvocation,
  type InvocationSummary,
} from "./subagents";

// SubagentsTab — slice 9. D18 view switch `[By step | All]` + D17 execution
// geometry + D16 nested mini-session. Replaces the old tab-per-subagent model
// (Overview tab + one tab per invocation).
//
//   • D18 [By step | All]: a segmented control in the tab TOOLBAR (English
//     labels; "By step" active by default; the `N subagents` count on the right).
//     Same dual-axis pattern as Git's D15.
//   • By step (D17): launchers grouped by their launching step — same step =
//     PARALLEL horizontal cards, different step = SEQUENTIAL vertical blocks
//     (turn+seq-contiguity heuristic in subagents.ts). Card click → nested
//     mini-session below the row (single-select).
//   • All (D18): turn/step-independent aggregate as a reused ComparisonList
//     (peer = subagent name; count desc; columns count / cost / tools). Row
//     expand → the subagent's nested mini-session (one per invocation).
//
// Both views reuse Step / ComparisonList / GitTab (via NestedMiniSession).
// Color is rationed (D10): neutral by default, clean red for failed runs/steps;
// runner identity via RunnerIcon (D4); no timestamp gutter (D5).

type View = "by-step" | "all";

export function SubagentsTab({
  invocations,
  topEvents,
  turnNumberByEventId,
  turnHeaderIds,
  childrenByParent,
  sessionById,
  bundle,
  currentId,
  selectedLauncherId,
  selectLauncher,
  selectedEventId,
  selectEvent,
  flashEventId,
  editByEventId,
  expandedAgents,
  toggleAgent,
  openSubSession,
}: {
  invocations: TranscriptEvent[];
  topEvents: TranscriptEvent[];
  turnNumberByEventId: Map<string, number>;
  turnHeaderIds: Map<string, string>;
  childrenByParent: Map<string, TranscriptEvent[]>;
  sessionById: Map<string, Session>;
  bundle: SessionBundle;
  currentId: string;
  selectedLauncherId: string | null;
  selectLauncher: (launcherId: string) => void;
  selectedEventId?: string;
  selectEvent: (eventId: string) => void;
  flashEventId: string | null;
  editByEventId: Map<string, { file: ChangedFile; hunks: DiffHunk[] }>;
  expandedAgents: Set<string>;
  toggleAgent: (eventId: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  const [view, setView] = useState<View>("by-step");

  const summarize = (e: TranscriptEvent): InvocationSummary => summarizeInvocation(e, childrenByParent, sessionById);

  const blocks = useMemo(
    () => groupLaunchersByStep(invocations, topEvents, turnNumberByEventId, turnHeaderIds),
    [invocations, topEvents, turnNumberByEventId, turnHeaderIds],
  );

  // D18 "All": aggregate launchers by subagent NAME (peer identity). Shared
  // dimension = invocation count; columns = count / cost / tools. Sorted by
  // count desc. Each member is a launcher → its nested mini-session on expand.
  const allGroups = useMemo<ComparisonGroup[]>(() => {
    type Acc = { name: string; events: TranscriptEvent[]; count: number; cost: number | null; tools: number };
    const byName = new Map<string, Acc>();
    for (const e of invocations) {
      const name = subagentName(e);
      const stats = launcherStats(summarize(e));
      let g = byName.get(name);
      if (!g) {
        g = { name, events: [], count: 0, cost: null, tools: 0 };
        byName.set(name, g);
      }
      g.events.push(e);
      g.count += 1;
      g.tools += stats.tools;
      if (stats.cost != null) g.cost = (g.cost ?? 0) + stats.cost;
    }
    return [...byName.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((g) => ({
        key: g.name,
        icon: "⌥",
        label: g.name,
        count: g.count,
        costUsd: g.cost,
        durationMs: 0,
        metric: (
          <>
            {g.cost != null ? fmtCost(g.cost) : "—"} · {fmtInt(g.tools)} tools
          </>
        ),
        events: g.events,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invocations, childrenByParent, sessionById]);

  const [expandedNames, setExpandedNames] = useState<Set<string>>(() => new Set());
  const toggleName = (key: string) =>
    setExpandedNames((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNested = (launcher: TranscriptEvent) => (
    <NestedMiniSession
      launcher={launcher}
      summary={summarize(launcher)}
      bundle={bundle}
      currentId={currentId}
      selectedEventId={selectedEventId}
      selectEvent={selectEvent}
      flashEventId={flashEventId}
      editByEventId={editByEventId}
      childrenByParent={childrenByParent}
      expandedAgents={expandedAgents}
      toggleAgent={toggleAgent}
      openSubSession={openSubSession}
    />
  );

  if (invocations.length === 0) {
    return (
      <div className="lds-sa-wrap" data-testid="sa-wrap">
        <div className="timeline" data-testid="timeline">
          <div className="empty" data-testid="empty" style={{ padding: "var(--sp-16)" }}>
            No sub-agent runs in this session.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lds-sa-wrap" data-testid="sa-wrap">
      {/* D18 view switch — segmented control in the tab toolbar (NOT the session
          header). English labels; "By step" default; `N subagents` count right. */}
      <div className="lds-sa-toolbar" data-testid="sa-toolbar">
        <Segmented
          className="lds-sa-seg"
          data-testid="sa-view-switch"
          options={[
            { value: "by-step", label: "By step" },
            { value: "all", label: "All" },
          ]}
          value={view}
          onChange={(v) => setView(v as View)}
        />
        <span className="lds-sa-toolbar-hint" data-testid="sa-toolbar-hint">
          {view === "by-step"
            ? "Laid out by execution geometry — parallel runs across, sequential runs down."
            : "Aggregated across the run — subagents compared by invocation count."}
        </span>
        <span className="lds-sa-toolbar-count" data-testid="sa-toolbar-count">
          {fmtInt(invocations.length)} subagents
        </span>
      </div>

      {view === "by-step" ? (
        <SubagentByStep
          blocks={blocks}
          childrenByParent={childrenByParent}
          sessionById={sessionById}
          bundle={bundle}
          currentId={currentId}
          selectedLauncherId={selectedLauncherId}
          selectLauncher={selectLauncher}
          selectedEventId={selectedEventId}
          selectEvent={selectEvent}
          flashEventId={flashEventId}
          editByEventId={editByEventId}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
          openSubSession={openSubSession}
        />
      ) : (
        <ComparisonList
          groups={allGroups}
          expandedKeys={expandedNames}
          toggleKey={toggleName}
          eyebrow="Subagents · by invocation count"
          hint="Click a row to expand each invocation's nested session."
          testidPrefix="sa-all"
          groupAttr="data-subagent-name"
          renderMember={renderNested}
        />
      )}
    </div>
  );
}
