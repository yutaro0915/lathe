"use client";

// components/OverviewView.tsx — the Overview / Home screen (v2: a funnel, not a
// dashboard).
//
// Overview answers "where do I dig next?" — not "here are some totals". It is a
// FULL-WIDTH analysis canvas with NO session rail: a rail that just jumped to the
// Sessions axis was a redundant second Sessions list (the user's complaint). The
// only navigation-bearing controls here are the project scope (an analysis
// condition, kept in the header) and the drill-downs baked into every panel.
//
// Every click is an ordinary link that moves the GLOBAL bar's current location
// (Sessions or Findings), so the browser back button always returns here — no
// implicit axis-crossing via a sidebar (design/ui-design-language.md IA, 2026-06-12).
//
//   1. Attention — THE point of the screen, placed first: G9 cost outliers,
//      error-heavy sessions, and pending findings. Each row links to the session
//      viewer / Findings axis. This is the "next places to dig" list.
//   2. The cross-session charts, now drill-down entry points (a model row scopes
//      the Sessions axis to that model; a time bar scopes it to that period;
//      a biggest-session row opens that session, with a status chip inline).
//
// In-session analytics — what one specific run did — live on the SessionViewer
// "Stats" tab (SessionStatsView). Cross-session aggregates do not belong there.

import { useMemo, useState } from "react";
import Link from "next/link";
import StatsView from "@/components/StatsView";
import { fmtCompact, fmtCost, fmtInt, humanizeDuration } from "@lathe/shared";
import type { Session, StatsBundle } from "@/lib/types";

// ---- Sessions-axis deep links (every drill-down is a plain link) -----------
// The Sessions axis (app/page.tsx → SessionViewer) seeds its session-list
// filters from these query params, so an Overview drill-down lands on the
// Sessions axis already scoped. Built here so the contract is in one place.
function sessionsHrefForModel(model: string): string {
  return `/?model=${encodeURIComponent(model)}`;
}
function sessionsHrefForPeriod(fromDay: string, toDay: string): string {
  return `/?from=${encodeURIComponent(fromDay)}&to=${encodeURIComponent(toDay)}`;
}
function sessionHref(id: string): string {
  return `/?session=${encodeURIComponent(id)}`;
}
function findingsHrefForSession(id: string): string {
  return `/findings?session=${encodeURIComponent(id)}`;
}

export default function OverviewView({
  sessions,
  stats,
  eventCounts,
  sessionProject,
  pendingFindings,
}: {
  sessions: Session[];
  stats: StatsBundle;
  eventCounts: Record<string, Record<string, number>>;
  sessionProject: Record<string, string>;
  pendingFindings: Record<string, number>;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");

  // sessions in the current scope (project) — drives the charts and the panels.
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

  // ---- Attention panel data (all derived from the in-scope sessions) ----------
  // ① G9 cost outliers: anomalous sessions, worst overrun first. The overrun ratio
  // (cost ÷ baseline threshold) is the "how bad" number the user reads at a glance.
  const costAlerts = useMemo(
    () =>
      scopeSessions
        .filter((s) => s.costAnomaly && s.costUsd != null)
        .map((s) => ({
          session: s,
          ratio:
            s.costAnomalyThresholdUsd > 0 ? (s.costUsd ?? 0) / s.costAnomalyThresholdUsd : null,
        }))
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
        .slice(0, 8),
    [scopeSessions],
  );

  // ② error-heavy sessions: most failed tool calls first (zero-error excluded).
  const errorSessions = useMemo(
    () =>
      scopeSessions
        .filter((s) => s.errorCount > 0)
        .sort((a, b) => b.errorCount - a.errorCount)
        .slice(0, 8),
    [scopeSessions],
  );

  // ③ pending findings: sessions with the most undecided findings first, plus the
  // scope-wide pending total (the entry point into the Findings axis).
  const pendingSessions = useMemo(
    () =>
      scopeSessions
        .map((s) => ({ session: s, pending: pendingFindings[s.id] ?? 0 }))
        .filter((r) => r.pending > 0)
        .sort((a, b) => b.pending - a.pending)
        .slice(0, 8),
    [scopeSessions, pendingFindings],
  );
  const pendingTotal = useMemo(
    () => scopeSessions.reduce((acc, s) => acc + (pendingFindings[s.id] ?? 0), 0),
    [scopeSessions, pendingFindings],
  );

  const attentionEmpty =
    costAlerts.length === 0 && errorSessions.length === 0 && pendingSessions.length === 0;

  return (
    <div className="overview-page" data-testid="overview-page">
      {/* Header — mirrors the session viewer's sessbar so the chrome stays
          consistent. The project scope lives here (an analysis condition, not a
          navigation control), alongside the scope totals. */}
      <div className="sessbar" data-testid="sessbar">
        <div className="sessbar-id" data-testid="sessbar-id">
          <span className="sessbar-title" data-testid="sessbar-title">Overview</span>
          <div className="project-select overview-scope" data-testid="project-select" title="Scope every panel to one project">
            <span aria-hidden>⊞</span>
            <select
              className="project-picker" data-testid="project-picker"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">All projects · {sessions.length} sessions</option>
              {stats.projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.project} · {p.sessions} ses · {p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}
                </option>
              ))}
            </select>
          </div>
          <span className="sessbar-meta" data-testid="sessbar-meta">attention items, then the cross-session breakdown</span>
        </div>
        <div className="sessbar-stats" data-testid="sessbar-stats">
          <div className="kstat" data-testid="kstat">
            <b>{fmtInt(scopeTotals.sessions)}</b>
            <span>sessions</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{scopeTotals.durationMs > 0 ? humanizeDuration(scopeTotals.durationMs) : "—"}</b>
            <span>duration</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{fmtCompact(scopeTotals.tokens)}</b>
            <span>tokens</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{scopeTotals.cost > 0 ? fmtCost(scopeTotals.cost) : "—"}</b>
            <span>cost</span>
          </div>
          <div className="kstat" data-testid="kstat" title="G9: cost > 5× runner median, min $50">
            <b>{fmtInt(scopeTotals.anomalies)}</b>
            <span>cost outliers</span>
          </div>
        </div>
      </div>

      {/* Full-width analysis canvas — no rail. */}
      <div className="overview-canvas" data-testid="overview-canvas" data-overview-version="2">
        {/* ======================= Attention (the lead panel) ======================= */}
        <section className="attn-panel" data-testid="attn-panel" data-panel="attention">
          <div className="attn-head" data-testid="attn-head">
            <span className="attn-title" data-testid="attn-title">NEEDS ATTENTION</span>
            <span className="muted small" data-testid="muted">{scopeLabel}</span>
          </div>

          {attentionEmpty ? (
            <div className="empty attn-empty" data-testid="empty">
              No cost outliers, errors, or pending findings in this scope.
            </div>
          ) : (
            <div className="attn-cols" data-testid="attn-cols">
              {/* ① G9 cost outliers */}
              <div className="attn-col" data-testid="attn-col" data-attn-group="cost">
                <div
                  className="attn-col-head" data-testid="attn-col-head"
                  title="G9: cost > 5× runner median, min $50"
                >
                  <span>COST OUTLIERS</span>
                  <span className="attn-col-basis mono" data-testid="attn-col-basis">&gt;5× runner median, min $50 (G9)</span>
                  <span className="attn-count mono" data-testid="attn-count">{costAlerts.length}</span>
                </div>
                {costAlerts.length === 0 ? (
                  <div className="attn-none" data-testid="attn-none">none</div>
                ) : (
                  costAlerts.map(({ session: s, ratio }) => (
                    <Link
                      key={s.id}
                      href={sessionHref(s.id)}
                      className="attn-row" data-testid="attn-row"
                      data-session-id={s.id}
                    >
                      <span className="attn-row-title" data-testid="attn-row-title" title={s.title}>{s.title}</span>
                      <span className="attn-row-meta" data-testid="attn-row-meta">
                        <span className="mono" data-testid="mono">{fmtCost(s.costUsd)}</span>
                        {ratio != null && (
                          <span className="badge neutral attn-ratio" data-testid="attn-ratio" title="cost ÷ baseline threshold">
                            ×{ratio.toFixed(1)}
                          </span>
                        )}
                      </span>
                    </Link>
                  ))
                )}
              </div>

              {/* ② error-heavy sessions */}
              <div className="attn-col" data-testid="attn-col" data-attn-group="errors">
                <div
                  className="attn-col-head" data-testid="attn-col-head"
                  title="Sessions ranked by failed tool calls (descending)"
                >
                  <span>MOST ERRORS</span>
                  <span className="attn-col-basis mono" data-testid="attn-col-basis">by failed tool calls</span>
                  <span className="attn-count mono" data-testid="attn-count">{errorSessions.length}</span>
                </div>
                {errorSessions.length === 0 ? (
                  <div className="attn-none" data-testid="attn-none">none</div>
                ) : (
                  errorSessions.map((s) => (
                    <Link
                      key={s.id}
                      href={sessionHref(s.id)}
                      className="attn-row" data-testid="attn-row"
                      data-session-id={s.id}
                    >
                      <span className="attn-row-title" data-testid="attn-row-title" title={s.title}>{s.title}</span>
                      <span className="attn-row-meta" data-testid="attn-row-meta">
                        <span className="badge err" data-testid="badge">{s.errorCount} err</span>
                      </span>
                    </Link>
                  ))
                )}
              </div>

              {/* ③ pending findings */}
              <div className="attn-col" data-testid="attn-col" data-attn-group="findings">
                <div
                  className="attn-col-head" data-testid="attn-col-head"
                  title="Findings with no verdict yet"
                >
                  <span>PENDING FINDINGS</span>
                  <Link
                    href="/findings"
                    className="attn-count-link mono" data-testid="attn-count-link"
                    title="View all undecided findings on the Findings axis"
                  >
                    {pendingTotal} →
                  </Link>
                </div>
                {pendingSessions.length === 0 ? (
                  <div className="attn-none" data-testid="attn-none">none</div>
                ) : (
                  pendingSessions.map(({ session: s, pending }) => (
                    <Link
                      key={s.id}
                      href={findingsHrefForSession(s.id)}
                      className="attn-row" data-testid="attn-row"
                      data-session-id={s.id}
                    >
                      <span className="attn-row-title" data-testid="attn-row-title" title={s.title}>{s.title}</span>
                      <span className="attn-row-meta" data-testid="attn-row-meta">
                        <span className="badge neutral" data-testid="badge">{pending} pending</span>
                      </span>
                    </Link>
                  ))
                )}
              </div>
            </div>
          )}
        </section>

        {/* ===================== cross-session charts ===================== */}
        {/* Same four charts, scoped to the project, but every one is now a
            drill-down entry point (links to the Sessions axis). */}
        <StatsView
          scopeSessions={scopeSessions}
          eventCounts={eventCounts}
          scopeLabel={scopeLabel}
          pendingFindings={pendingFindings}
          modelHref={sessionsHrefForModel}
          periodHref={sessionsHrefForPeriod}
          sessionHref={sessionHref}
        />
      </div>
    </div>
  );
}
