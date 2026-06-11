"use client";

// components/OverviewView.tsx — the Overview / Home screen.
//
// The right place to ask "where did the work go across projects?". Picking a
// project here scopes the session list AND the cross-session charts (cost &
// tokens over time, cost by model, event composition, biggest sessions).
//
// In-session analytics — what one specific run did — live on the SessionViewer
// "Stats" tab (SessionStatsView). Don't put cross-session aggregates there:
// they're irrelevant to the session the user is inspecting.

import { useMemo, useState } from "react";
import Link from "next/link";
import StatsView from "@/components/StatsView";
import CostAnomalyChip from "@/components/CostAnomalyChip";
import { fmtCompact, fmtCost, fmtInt, humanizeDuration } from "@lathe/shared";
import type { Session, StatsBundle } from "@/lib/types";

export default function OverviewView({
  sessions,
  stats,
  eventCounts,
  sessionProject,
}: {
  sessions: Session[];
  stats: StatsBundle;
  eventCounts: Record<string, Record<string, number>>;
  sessionProject: Record<string, string>;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");

  // sessions in the current scope (project) — drives the charts and the list.
  const scopeSessions = useMemo(() => {
    if (projectFilter === "all") return sessions;
    return sessions.filter((s) => (sessionProject[s.id] ?? "(no edits)") === projectFilter);
  }, [sessions, projectFilter, sessionProject]);

  const scopeTotals = useMemo(() => {
    let durationMs = 0, tokens = 0, cost = 0, anomalies = 0;
    for (const s of scopeSessions) {
      durationMs += s.durationMs ?? 0;
      tokens += s.tokenUsage ?? 0;
      if (s.costUsd != null) cost += s.costUsd;
      if (s.costAnomaly) anomalies += 1;
    }
    return { sessions: scopeSessions.length, durationMs, tokens, cost, anomalies };
  }, [scopeSessions]);

  const scopeLabel = projectFilter === "all" ? "All projects" : projectFilter;

  return (
    <div className="overview-page">
      {/* sessbar-like header (matches the session viewer so the chrome stays consistent) */}
      <div className="sessbar">
        <div className="sessbar-id">
          <span className="sessbar-title">Overview</span>
          <span className="sessbar-meta">
            {scopeLabel} · sessions across projects, grouped by the directory each one changed most
          </span>
        </div>
        <div className="sessbar-stats">
          <div className="kstat">
            <b>{fmtInt(scopeTotals.sessions)}</b>
            <span>sessions</span>
          </div>
          <div className="kstat">
            <b>{scopeTotals.durationMs > 0 ? humanizeDuration(scopeTotals.durationMs) : "—"}</b>
            <span>duration</span>
          </div>
          <div className="kstat">
            <b>{fmtCompact(scopeTotals.tokens)}</b>
            <span>tokens</span>
          </div>
          <div className="kstat">
            <b>{scopeTotals.cost > 0 ? fmtCost(scopeTotals.cost) : "—"}</b>
            <span>cost</span>
          </div>
          <div className="kstat">
            <b>{fmtInt(scopeTotals.anomalies)}</b>
            <span>cost alerts</span>
          </div>
        </div>
      </div>

      <div
        className="layout3 overview-shell"
        style={{ gridTemplateColumns: "var(--sidebar-w) minmax(0,1fr)" }}
      >
        {/* Left rail: project picker + a recent-sessions glance. Picking a session
            jumps to the SessionViewer (where in-session analytics live). */}
        <aside className="sidebar">
          <Link href="/" className="overview-back" title="Back to the session viewer">
            ← Session viewer
          </Link>
          <div className="project-select">
            <span aria-hidden>⊞</span>
            <select
              className="project-picker"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              title="Scope the overview charts to one project"
            >
              <option value="all">All projects · {sessions.length} sessions</option>
              {stats.projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.project} · {p.sessions} ses · {p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}
                </option>
              ))}
            </select>
          </div>

          <div className="session-head">
            <span>
              <span className="title">Sessions in scope</span>
              <span className="count">{scopeSessions.length}</span>
            </span>
          </div>
          <div className="sidebar-scroll">
            <div className="session-list">
              {scopeSessions.slice(0, 60).map((s) => (
                <Link
                  key={s.id}
                  href={`/?session=${encodeURIComponent(s.id)}`}
                  data-session-id={s.id}
                  className="session-item"
                  style={{ textAlign: "left", display: "block" }}
                >
                  <div className="si-top">
                    <span className="si-title">{s.title}</span>
                    <span className="si-flags">
                      <CostAnomalyChip session={s} />
                      {s.errorCount > 0 && (
                        <span className="badge err">{s.errorCount} err</span>
                      )}
                    </span>
                  </div>
                  <div className="si-meta">
                    <span>{s.durationMs != null && s.durationMs > 0 ? humanizeDuration(s.durationMs) : "—"}</span>
                    <span className="dot">·</span>
                    <span>{s.model ?? "—"}</span>
                  </div>
                  <div className="si-stats">
                    <span className="chip token">{fmtCompact(s.tokenUsage)} tok</span>
                    <span className="chip cost">
                      {s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : "—"}
                    </span>
                  </div>
                </Link>
              ))}
              {scopeSessions.length === 0 && (
                <div className="empty" style={{ padding: 12 }}>No sessions in this scope.</div>
              )}
              {scopeSessions.length > 60 && (
                <div className="muted small" style={{ padding: "8px 12px" }}>
                  showing first 60 of {scopeSessions.length}
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="main">
          {/* Reuse the same cross-session charts, scoped to the chosen project. */}
          <StatsView
            scopeSessions={scopeSessions}
            eventCounts={eventCounts}
            scopeLabel={scopeLabel}
          />
        </main>
      </div>
    </div>
  );
}
