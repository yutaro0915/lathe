import * as React from "react";
import { useMemo, useState } from "react";
import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import type { ChangedFile, DiffHunk, EventType, SessionBundle, TranscriptEvent } from "@/lib/types";
import { fmtCost, fmtInt } from "@lathe/shared";
import { RunnerIcon } from "@/design-system/components";
import { Step, type StepEdit } from "./Step";
import { ComparisonList, type ComparisonGroup } from "./ComparisonList";
import { GitTab } from "./GitTab";
import { launcherStats, subagentName, type InvocationSummary } from "./subagents";

// NestedMiniSession — D16: a sub-agent IS a nested session, inspected with the
// SAME 3 facets as the parent (Transcript / Tools / Git). When a By-step card or
// an All row is selected, this expands BELOW it: a header (runner icon + name +
// cost·tools + × close) + a 3-tab bar + the active tab's content, SCOPED to the
// sub-agent's own events.
//
//   • inline kids → the sub-agent's events are its children
//     (childrenByParent.get(launcher.id)). The nested Transcript is a FLAT step
//     list (step 1..N), NOT the parent's turn-accordion; nested Tools is those
//     kids aggregated by tool type (reused ComparisonList); nested Git is the
//     kids' file changes (reused GitTab, scoped to the kid-attributed diff).
//   • linkedChild → the kids are not inline (the full transcript is a separate
//     linked session). We do NOT fabricate a nested transcript — we keep the
//     honest OPEN SUB-SESSION navigation inside the nested area instead.
//
// Color is rationed (D10): neutral by default; the only privileged hue is the
// per-step error STATE carried by Step (var(--c-error)) and a failed-run signal.

type NestedTab = "transcript" | "tools" | "git";

const TOOL_AGG_TYPES = new Set<EventType>([
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
]);

// A SessionBundle scoped to just the kids' diff: keep only changed files whose
// hunks are attributed to one of the kid event ids (so the nested Git tab shows
// the sub-agent's file changes, not the whole parent session's). Reuses the same
// bundle shape GitTab/DiffViewer already consume.
function scopeBundleToKids(bundle: SessionBundle, kidIds: Set<string>): SessionBundle {
  const keptFileIds = new Set<string>();
  const hunks: SessionBundle["hunks"] = {};
  const attributions: SessionBundle["attributions"] = {};
  for (const file of bundle.changedFiles) {
    const fileHunks = bundle.hunks[file.id] ?? [];
    const keptHunks: DiffHunk[] = [];
    for (const h of fileHunks) {
      const attrs = (bundle.attributions[h.id] ?? []).filter((a) => a.eventId && kidIds.has(a.eventId));
      if (attrs.length > 0) {
        keptHunks.push(h);
        attributions[h.id] = attrs;
      }
    }
    if (keptHunks.length > 0) {
      keptFileIds.add(file.id);
      hunks[file.id] = keptHunks;
    }
  }
  const changedFiles = bundle.changedFiles.filter((f) => keptFileIds.has(f.id));
  const linkedEvents: SessionBundle["linkedEvents"] = {};
  for (const id of keptFileIds) if (bundle.linkedEvents[id]) linkedEvents[id] = bundle.linkedEvents[id];
  const eventFiles: SessionBundle["eventFiles"] = {};
  for (const id of kidIds) if (bundle.eventFiles[id]) eventFiles[id] = bundle.eventFiles[id];
  return { ...bundle, changedFiles, hunks, attributions, linkedEvents, eventFiles, annotations: [] };
}

export function NestedMiniSession({
  launcher,
  summary,
  bundle,
  currentId,
  selectedEventId,
  selectEvent,
  flashEventId,
  editByEventId,
  childrenByParent,
  expandedAgents,
  toggleAgent,
  openSubSession,
}: {
  launcher: TranscriptEvent;
  summary: InvocationSummary;
  bundle: SessionBundle;
  currentId: string;
  selectedEventId?: string;
  selectEvent: (eventId: string) => void;
  flashEventId: string | null;
  editByEventId: Map<string, { file: ChangedFile; hunks: DiffHunk[] }>;
  childrenByParent: Map<string, TranscriptEvent[]>;
  expandedAgents: Set<string>;
  toggleAgent: (eventId: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  const { kids, linkedChild } = summary;
  const stats = launcherStats(summary);
  const [tab, setTab] = useState<NestedTab>("transcript");
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());
  const resolveEdit = (e: TranscriptEvent): StepEdit => editByEventId.get(e.id) ?? null;
  const runner = linkedChild?.runner ?? "";
  const name = subagentName(launcher);

  // nested Tools: aggregate the kids by tool type → reused ComparisonList (slice 7
  // shape), with the kids' invocation Steps on expand. Sorted by count desc.
  const toolGroups = useMemo<ComparisonGroup[]>(() => {
    type Acc = { type: EventType; events: TranscriptEvent[]; count: number; costUsd: number | null; durationMs: number };
    const byType = new Map<EventType, Acc>();
    for (const e of kids) {
      if (!TOOL_AGG_TYPES.has(e.type)) continue;
      let g = byType.get(e.type);
      if (!g) {
        g = { type: e.type, events: [], count: 0, costUsd: null, durationMs: 0 };
        byType.set(e.type, g);
      }
      g.events.push(e);
      g.count += 1;
      g.durationMs += e.durationMs ?? 0;
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
  }, [kids]);

  const kidIds = useMemo(() => new Set(kids.map((k) => k.id)), [kids]);
  const scopedBundle = useMemo(() => scopeBundleToKids(bundle, kidIds), [bundle, kidIds]);

  const toggleType = (type: string) =>
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  const renderStep = (e: TranscriptEvent) => (
    <Step
      event={e}
      depth={1}
      selectedEventId={selectedEventId}
      flashEventId={flashEventId}
      childSteps={childrenByParent.get(e.id) ?? []}
      agentExpanded={expandedAgents.has(e.id)}
      onToggleAgent={toggleAgent}
      edit={resolveEdit(e)}
      resolveEdit={resolveEdit}
      onSelect={selectEvent}
    />
  );

  return (
    <div className="lds-sa-nested" data-testid="sa-nested">
      <div className="lds-sa-nested-head" data-testid="sa-nested-head">
        <RunnerIcon runner={runner} size={18} />
        <span className="lds-sa-nested-name" data-testid="sa-nested-name" data-ellipsis-ok title={name}>
          {name}
        </span>
        <span className="lds-sa-nested-stat" data-testid="sa-nested-stat">
          {stats.cost != null ? fmtCost(stats.cost) : "—"} · {fmtInt(stats.tools)} tools
        </span>
        {stats.runFailed && (
          <span className="lds-sa-nested-err" data-testid="sa-nested-err" title="the run's own verdict (is_error / non-zero exit)">
            error
          </span>
        )}
        <button
          type="button"
          className="lds-sa-nested-close"
          data-testid="sa-nested-close"
          aria-label="Close nested session"
          onClick={() => selectEvent(launcher.id)}
          title="Close"
        >
          ×
        </button>
      </div>

      {linkedChild ? (
        // D16 linkedChild branch: the kids are NOT inline (separate linked
        // session). Keep the honest OPEN SUB-SESSION navigation — do not
        // fabricate a nested transcript.
        <div className="lds-sa-nested-linked" data-testid="sa-nested-linked">
          <div className="lds-sa-nested-linked-title" data-testid="sa-nested-linked-title">
            {linkedChild.title}
          </div>
          <div className="lds-sa-nested-linked-hint">
            This sub-agent ran as a separate linked session. Open it to inspect its captured transcript.
          </div>
          <button
            type="button"
            className="lds-sa-open-subsession"
            data-testid="sa-open-subsession"
            onClick={() => openSubSession(linkedChild.id)}
          >
            OPEN SUB-SESSION →
          </button>
        </div>
      ) : (
        <>
          <div className="lds-sa-nested-tabs" data-testid="sa-nested-tabs" role="tablist" aria-label="Nested session facets">
            {(["transcript", "tools", "git"] as NestedTab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`lds-sa-nested-tab${tab === t ? " is-active" : ""}`}
                data-testid="sa-nested-tab"
                data-nested-tab={t}
                onClick={() => setTab(t)}
              >
                {t === "transcript" ? "Transcript" : t === "tools" ? "Tools" : "Git"}
              </button>
            ))}
          </div>

          <div className="lds-sa-nested-body" data-testid="sa-nested-body" data-nested-tab={tab}>
            {tab === "transcript" &&
              (kids.length === 0 ? (
                <div className="empty" data-testid="empty" style={{ padding: "10px 14px" }}>
                  internal steps not captured
                </div>
              ) : (
                // nested Transcript = the kids as a FLAT list of reused Steps (D8),
                // step 1..N (NOT the parent turn-accordion).
                <div className="lds-sa-nested-steps" data-testid="sa-nested-steps">
                  {kids.map((k) => (
                    <div className="lds-sa-nested-step" data-testid="sa-nested-step" key={k.id}>
                      <span className="lds-sa-nested-stepno" data-testid="sa-nested-stepno" aria-hidden>
                        step {kids.indexOf(k) + 1}
                      </span>
                      <div className="lds-sa-nested-stepbody">{renderStep(k)}</div>
                    </div>
                  ))}
                </div>
              ))}

            {tab === "tools" &&
              (toolGroups.length === 0 ? (
                <div className="empty" data-testid="empty" style={{ padding: "10px 14px" }}>
                  No tool events in this sub-agent.
                </div>
              ) : (
                <ComparisonList
                  groups={toolGroups}
                  expandedKeys={expandedTypes}
                  toggleKey={toggleType}
                  eyebrow="Tools · by invocation count"
                  hint="Click a row to expand its invocations."
                  testidPrefix="sa-tool"
                  groupAttr="data-tool-type"
                  renderMember={renderStep}
                />
              ))}

            {tab === "git" &&
              (scopedBundle.changedFiles.length === 0 ? (
                <div className="empty" data-testid="empty" style={{ padding: "10px 14px" }}>
                  No file changes attributed to this sub-agent.
                </div>
              ) : (
                <GitTab
                  bundle={scopedBundle}
                  currentId={currentId}
                  onJumpToEvent={(eid) => selectEvent(eid)}
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}
