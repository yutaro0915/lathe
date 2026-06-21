"use client";

// components/SessionsSurface.tsx — the Sessions list SURFACE (DS v1).
//
// The cross-session browse surface. Per the design.md IA decision, the list is
// no longer pushed into a cramped left rail: the left is navigation only, and the
// list lives FULL-WIDTH in the work area (center). Opening a row drills into the
// session workspace (router.push("/?session=<id>")), which the existing viewer
// renders.
//
// Built from Lathe Design System v1 primitives + the sessions-grid layout
// classes (app/design-system/shell.css). Columns: Session 1fr / Runner 84px /
// Model 86px (D3, mono) / Tokens 92px / Turns 64px / Errors 72px / Cost 84px —
// head sticky, 54px rows, hover. Numbers are mono + tabular. Per D5 a session is
// a span, so no timestamp is shown — the meta line carries only the duration.
//
// Machine-readable / e2e contract (dual-operability + data oracles): each row
// keeps the stable `session-item` class and `data-session-id`, renders the
// `runner-badge`, the `chip cost`, and the cost `anomaly-chip`, alongside the DS
// `lds-sg-*` visual classes — so the cost-anomaly / runner / cost oracles target
// the same hooks while the surface is restyled.

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fmtCost, fmtTok, humanizeDuration, shortModel } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import { EVENT_LABEL } from "@/lib/event-display";
import CostAnomalyChip from "@/components/CostAnomalyChip";
import Surface from "@/components/Surface";
import { Icon } from "@/components/ds/icons";
import {
  Badge,
  Button,
  Checkbox,
  RunnerIcon,
  SearchInput,
  Segmented,
  Select,
} from "@/components/ds";
import type { EventType, Session } from "@/lib/types";

type SortKey = "recent" | "oldest" | "tokens" | "cost" | "errors";

// Event types shown as filter chips, in legend order (mirrors the viewer's set).
const CHIP_TYPES: EventType[] = [
  "user_message",
  "assistant_message",
  "file_read",
  "file_edit",
  "file_write",
  "bash",
  "subagent",
  "memory",
  "hook",
];

// event type -> dot color token (rationed; a row/chip gets a dot, never a fill).
const TYPE_DOT: Record<string, string> = {
  user_message: "var(--c-user)",
  assistant_message: "var(--c-assistant)",
  file_read: "var(--c-read)",
  file_edit: "var(--c-edit)",
  file_write: "var(--c-write)",
  bash: "var(--c-bash)",
  subagent: "var(--c-subagent)",
  memory: "var(--c-memory)",
  hook: "var(--c-hook)",
  error: "var(--c-error)",
};

export default function SessionsSurface({
  sessions,
  sessionProject,
  initialModel,
  initialFrom,
  initialTo,
  initialErrors,
}: {
  sessions: Session[];
  sessionProject: Record<string, string>;
  // Overview drill-down deep links (all optional): seed the list MODEL / ERRORS /
  // date-range filters so an Overview click lands on a pre-scoped list.
  initialModel?: string;
  initialFrom?: string; // YYYY-MM-DD inclusive
  initialTo?: string; // YYYY-MM-DD inclusive
  initialErrors?: "yes" | "no";
}) {
  const router = useRouter();
  // Project scope is the shell-owned control now (TopBar selector → ?project=);
  // the list reads it, the same filtering the old in-surface picker drove.
  const searchParams = useSearchParams();
  const projectFilter = searchParams.get("project") ?? "all";
  const [search, setSearch] = useState("");
  // open the filter panel up front when a drill-down pre-seeded a filter, so the
  // active scope is visible rather than silently applied.
  const seeded = !!(initialModel || initialFrom || initialTo || initialErrors);
  const [filtersOpen, setFiltersOpen] = useState(seeded);
  const [modelFilter, setModelFilter] = useState(initialModel ?? "all");
  const [errorsFilter, setErrorsFilter] = useState(initialErrors ?? "any");
  const [filterMode, setFilterMode] = useState("hide");
  const [showSubSessions, setShowSubSessions] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  // date-range (YYYY-MM-DD inclusive) from an Overview "cost over time" drill-down.
  const [dateFrom, setDateFrom] = useState<string | null>(initialFrom ?? null);
  const [dateTo, setDateTo] = useState<string | null>(initialTo ?? null);

  const models = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.model) set.add(s.model);
    return Array.from(set).sort();
  }, [sessions]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = sessions.filter((s) => {
      if (!showSubSessions && s.parentSessionId) return false;
      if (projectFilter !== "all" && sessionProject[s.id] !== projectFilter) return false;
      if (modelFilter !== "all" && s.model !== modelFilter) return false;
      if (errorsFilter === "yes" && s.errorCount === 0) return false;
      if (errorsFilter === "no" && s.errorCount > 0) return false;
      // date-range (Overview "cost over time" drill-down); startedAt begins with
      // YYYY-MM-DD, inclusive on both ends.
      if (dateFrom || dateTo) {
        const day = (s.startedAt ?? "").slice(0, 10);
        if (!day) return false;
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
      }
      if (q && !(s.title?.toLowerCase().includes(q) || (s.model ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
    rows = rows.slice().sort((a, b) => {
      switch (sortKey) {
        case "oldest":
          return a.startedAt.localeCompare(b.startedAt);
        case "tokens":
          return b.tokenUsage - a.tokenUsage;
        case "cost":
          return (b.costUsd ?? -1) - (a.costUsd ?? -1);
        case "errors":
          return b.errorCount - a.errorCount;
        case "recent":
        default:
          return b.startedAt.localeCompare(a.startedAt);
      }
    });
    return rows;
  }, [sessions, search, showSubSessions, projectFilter, modelFilter, errorsFilter, sortKey, sessionProject, dateFrom, dateTo]);

  const openSession = (id: string) => router.push(`/?session=${encodeURIComponent(id)}`);

  // Header actions for the WorkareaHeader (right slot). These are surface-feature
  // controls (search / filters / sort) and live HERE, not in the shell TopBar.
  // Project SCOPE is no longer a per-surface control — it moved to the shell
  // TopBar selector (?project=), which the list reads above.
  const actions = (
    <>
      <div style={{ width: 240 }}>
        <SearchInput
          placeholder="Search sessions…"
          kbd="⌘K"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Button
        variant={filtersOpen ? "default" : "ghost"}
        size="sm"
        icon={<Icon name={filtersOpen ? "chevronDown" : "chevronRight"} size={13} />}
        onClick={() => setFiltersOpen((o) => !o)}
      >
        Filters
      </Button>
      <Select
        value={sortKey}
        options={[
          { value: "recent", label: "Recent first" },
          { value: "oldest", label: "Oldest first" },
          { value: "tokens", label: "Most tokens" },
          { value: "cost", label: "Costliest" },
          { value: "errors", label: "Most errors" },
        ]}
        onChange={(e) => setSortKey(e.target.value as SortKey)}
        title="Sort the session list"
      />
    </>
  );

  return (
    <Surface surface="sessions" title="Sessions" meta={`${visible.length} in view`} actions={actions}>
      {filtersOpen ? (
        <div className="lds-sessions-filters" data-testid="lds-sessions-filters">
          <div className="lds-sf-row" data-testid="lds-sf-row">
            <span className="lds-flabel" data-testid="lds-flabel">Event types</span>
            <div className="lds-chip-filters" data-testid="lds-chip-filters">
              {CHIP_TYPES.map((t) => (
                <span key={t} className="lds-fchip" data-testid="lds-fchip">
                  <span className="lds-fchip-d" data-testid="lds-fchip-d" style={{ background: TYPE_DOT[t] }} />
                  {EVENT_LABEL[t]}
                </span>
              ))}
              <span className="lds-fchip err" data-testid="lds-fchip">
                <span className="lds-fchip-d" data-testid="lds-fchip-d" style={{ background: "var(--c-error)" }} />
                {EVENT_LABEL.error}
              </span>
            </div>
          </div>
          <div className="lds-sf-controls" data-testid="lds-sf-controls">
            <Segmented
              options={[
                { value: "highlight", label: "Highlight" },
                { value: "hide", label: "Hide" },
              ]}
              value={filterMode}
              onChange={setFilterMode}
            />
            <Select
              value={modelFilter}
              options={[{ value: "all", label: "All models" }, ...models.map((m) => ({ value: m, label: m }))]}
              onChange={(e) => setModelFilter(e.target.value)}
            />
            <Select
              value={errorsFilter}
              options={[
                { value: "any", label: "Any" },
                { value: "yes", label: "Has errors" },
                { value: "no", label: "No errors" },
              ]}
              onChange={(e) => setErrorsFilter(e.target.value)}
            />
            <Checkbox
              checked={showSubSessions}
              onChange={(e) => setShowSubSessions(e.target.checked)}
              label="show sub-sessions"
            />
            {(dateFrom || dateTo) && (
              <span className="date-range-banner" data-testid="date-range-banner" data-from={dateFrom ?? ""} data-to={dateTo ?? ""}>
                <span className="mono" data-testid="mono">
                  {dateFrom ?? "…"}
                  {dateTo && dateTo !== dateFrom ? ` – ${dateTo}` : ""}
                </span>
                <button
                  type="button"
                  className="clear" data-testid="clear"
                  onClick={() => {
                    setDateFrom(null);
                    setDateTo(null);
                  }}
                >
                  Clear
                </button>
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* the surface root keeps the `session-list` hook; rows keep `session-item`
          + data-session-id so the cross-session data oracles target them. */}
      <div className="lds-page-scroll lds-sessions-grid session-list" data-testid="session-list">
        <div className="lds-sg-head" data-testid="lds-sg-head">
          <span>Session</span>
          <span>Runner</span>
          <span>Model</span>
          <span className="r" data-testid="r">Tokens</span>
          <span className="r" data-testid="r">Turns</span>
          <span className="r" data-testid="r">Errors</span>
          <span className="r" data-testid="r">Cost</span>
        </div>
        {visible.map((s) => {
          return (
            <button
              key={s.id}
              type="button"
              data-session-id={s.id}
              className="lds-sg-row session-item" data-testid="session-item"
              onClick={() => openSession(s.id)}
            >
              <span className="lds-sg-main" data-testid="lds-sg-main">
                <span className="lds-sg-title" data-testid="lds-sg-title" title={s.title}>{s.title}</span>
                {/* D5: a session is a span, not an instant — no timestamp is
                    shown (an arbitrary point-in-time would be a lie). The meta
                    line now carries ONLY the duration (a span is honest). Model
                    moved out to its own column (D3 comparison-list). The single
                    duration item cannot ellipsize-silently, so no title needed. */}
                <span className="lds-sg-meta" data-testid="lds-sg-meta">
                  <span>{humanizeDuration(s.durationMs)}</span>
                </span>
              </span>
              <span className="lds-sg-flags" data-testid="lds-sg-flags">
                {/* D4: runner = color + monogram icon (full name in title); the
                    stable `runner-badge` hook moves to this wrapper, and the full
                    runner name rides as visually-hidden text so the runner data
                    oracle (and screen readers) still resolve it by name. */}
                <span className="runner-badge" data-testid="runner-badge" title={RUNNER_LABEL[s.runner]}>
                  <RunnerIcon runner={s.runner} />
                  <span className="lds-sr-only">{RUNNER_LABEL[s.runner]}</span>
                </span>
                <CostAnomalyChip session={s} />
              </span>
              {/* D3: Model promoted to its own column (after Runner, before the
                  numeric columns). Mono, secondary, ellipsis on overflow; the
                  full model string rides as `title` so any clip is non-silent
                  (the layout-integrity no-truncation gate exempts a titled
                  clipped label — same pattern as lds-sg-title above). */}
              <span className="lds-sg-model" data-testid="lds-sg-model" title={s.model ?? ""}>{shortModel(s.model)}</span>
              <span className="lds-sg-num r" data-testid="lds-sg-num">{fmtTok(s.tokenUsage)}</span>
              <span className="lds-sg-num r" data-testid="lds-sg-num">{s.turnCount}</span>
              <span className="r" data-testid="r">
                {s.errorCount > 0 ? <Badge tone="err">{s.errorCount}</Badge> : <span className="lds-sg-zero" data-testid="lds-sg-zero">0</span>}
              </span>
              <span className={`lds-sg-cost chip cost r${s.costUsd == null ? " muted" : ""}`} data-testid="chip" data-cell="cost">
                {fmtCost(s.costUsd)}
              </span>
            </button>
          );
        })}
        {visible.length === 0 ? <div className="lds-sg-empty" data-testid="lds-sg-empty">No sessions match.</div> : null}
      </div>
    </Surface>
  );
}
