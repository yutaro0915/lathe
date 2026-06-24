import { useMemo } from "react";
import { TYPE_GLYPH } from "@/lib/event-display";
import type { ChangedFile, DiffHunk, SessionBundle, TranscriptEvent } from "@/lib/types";
import { Step, type StepEdit } from "./Step";
import { ComparisonList, type ComparisonGroup } from "./ComparisonList";

// SkillsTab — D33 (Skills have the same shape as Tools): a skill is "a
// capability the agent used", the SAME meaning structure as a tool invocation (N
// times). So Skills is the SAME comparison-list as Tools (D11), aggregated by
// the capability NAME, sorted by invocation count (descending). Clicking a
// capability row expands its invocations IN PLACE (D12), each rendered with the
// REUSED single Step component (D8). No side inspector, no navigation. Color is
// rationed (D10): neutral rows; the only privileged hue is the per-invocation
// error STATE carried by Step (var(--c-error)). No timestamp gutter (D5).
//
// The comparison-list SHELL is the shared ComparisonList component (the same one
// ToolsTab uses) — SkillsTab only supplies the aggregation (by capability name)
// and the per-invocation Step.
//
// CAPABILITY NAME — where it lives on a `skill` event (verified against the
// scratch DB + the ingest writers, apps/web/scripts/ingest/shared.ts +
// providers/codex.ts):
//   • Codex: `meta.skill` holds the skill name (e.g. "openai-docs", "imagegen"),
//     and `title` is "Skill · <name>".
//   • Claude: the Skill tool yields `title` "Skill · <name>" when a name was
//     captured; in practice most Claude Skill events arrive with NO captured
//     name ("Skill · " with empty meta), so they aggregate into one "(unnamed
//     skill)" group — which is honest about the data rather than fabricating a
//     name. Aggregation key = meta.skill ?? (title after "Skill · ") ?? unnamed.

const UNNAMED = "(unnamed skill)";

// Derive the capability name for a `skill` event. Prefer meta.skill (Codex),
// then the title suffix after the "Skill · " prefix, else the unnamed bucket.
function skillName(e: TranscriptEvent): string {
  if (e.meta) {
    try {
      const meta = JSON.parse(e.meta);
      if (typeof meta.skill === "string" && meta.skill.trim()) return meta.skill.trim();
    } catch {
      /* fall through to title */
    }
  }
  const fromTitle = e.title.replace(/^Skill\s*·\s*/i, "").trim();
  return fromTitle || UNNAMED;
}

// Per-event cost share (same derivation as ToolsTab): a direct meta.costUsd when
// present, else this event's token-proportional share of the session cost.
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

export function SkillsTab({
  bundle,
  expandedSkills,
  toggleSkill,
  selectedEventId,
  selectEvent,
  expandedAgents,
  toggleAgent,
  editByEventId,
  childrenByParent,
  flashEventId,
}: {
  bundle: SessionBundle;
  expandedSkills: Set<string>;
  toggleSkill: (key: string) => void;
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

  // Group this session's `skill` events by capability NAME (D33 aggregation key),
  // then sort by invocation count descending. Cost / duration summed per name.
  const groups = useMemo<ComparisonGroup[]>(() => {
    type Acc = { name: string; events: TranscriptEvent[]; count: number; costUsd: number | null; durationMs: number };
    const byName = new Map<string, Acc>();
    for (const e of events) {
      if (e.type !== "skill") continue;
      const name = skillName(e);
      let g = byName.get(name);
      if (!g) {
        g = { name, events: [], count: 0, costUsd: null, durationMs: 0 };
        byName.set(name, g);
      }
      g.events.push(e);
      g.count += 1;
      g.durationMs += e.durationMs ?? 0;
      const cost = readEventCost(e, bundle);
      if (cost != null) g.costUsd = (g.costUsd ?? 0) + cost;
    }
    return [...byName.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((g) => ({
        key: g.name,
        // neutral skill glyph (D4/D10) — the same star the timeline uses for skills.
        icon: TYPE_GLYPH.skill,
        label: g.name,
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
          No skill events.
        </div>
      </div>
    );
  }

  return (
    <ComparisonList
      groups={groups}
      expandedKeys={expandedSkills}
      toggleKey={toggleSkill}
      eyebrow="Skills · by invocation count"
      hint="Click a row to expand its invocations."
      testidPrefix="skill"
      groupAttr="data-skill-name"
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
