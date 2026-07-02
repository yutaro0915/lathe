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
//   2. Trends — runner median cost, cost over time, and findings by kind.
//
// In-session analytics — what one specific run did — live on the SessionViewer
// "Stats" tab (SessionStatsView). Cross-session aggregates do not belong there.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Pressable, Select, Surface } from "@/design-system/components";
import OverviewTrends from "@/components/OverviewTrends";
import { fmtCompact, fmtCost, fmtInt, humanizeDuration } from "@lathe/shared";
import {
  SESSION_CLASS_OPTIONS,
  sessionClassFilterOrDefault,
  sessionClassLabel,
  writeSessionClassParam,
  type SessionClassFilter,
} from "@/lib/session-class";
import { countFindingKindsForSessionScope } from "@/lib/finding-kind-scope";
import type { FindingKindSessionRef, Session } from "@/lib/types";

// ---- Sessions-axis deep links (every drill-down is a plain link) -----------
// The Sessions axis (app/page.tsx → SessionViewer) seeds its session-list
// filters from these query params, so an Overview drill-down lands on the
// Sessions axis already scoped. Built here so the contract is in one place.
function sessionsHrefForPeriod(fromDay: string, toDay: string, sessionClass: SessionClassFilter): string {
  const params = new URLSearchParams();
  params.set("from", fromDay);
  params.set("to", toDay);
  writeSessionClassParam(params, sessionClass);
  return `/?${params.toString()}`;
}
function sessionHref(id: string, sessionClass: SessionClassFilter): string {
  const params = new URLSearchParams();
  params.set("session", id);
  writeSessionClassParam(params, sessionClass);
  return `/?${params.toString()}`;
}
function findingsHrefForSession(id: string): string {
  return `/findings?session=${encodeURIComponent(id)}`;
}

export default function OverviewView({
  sessions,
  sessionProject,
  pendingFindings,
  findingKindSessionRefs,
}: {
  sessions: Session[];
  sessionProject: Record<string, string>;
  pendingFindings: Record<string, number>;
  findingKindSessionRefs: FindingKindSessionRef[];
}) {
  // Project scope is the shell-owned control now (TopBar selector → ?project=);
  // Overview reads it to scope every panel, the same filtering its old in-header
  // picker drove.
  const router = useRouter();
  const pathname = usePathname() ?? "/overview";
  const searchParams = useSearchParams();
  const projectFilter = searchParams.get("project") ?? "all";
  const activeSessionClass = sessionClassFilterOrDefault(searchParams.get("sessionClass"));

  const updateSessionClass = (value: SessionClassFilter) => {
    const next = new URLSearchParams(searchParams.toString());
    writeSessionClassParam(next, value);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // ---- dismissed Attention columns (VISIBILITY, decoupled from the filter) ----
  // The three Attention columns are derived from the project filter, but a user
  // may want to remove a column independently of the scope. `dismissed` holds the
  // group keys (`cost` / `errors` / `findings`) the user has hidden; it is wholly
  // separate from `projectFilter` so changing the scope never re-adds a hidden
  // column. Persisted to localStorage so a removal survives a reload.
  //
  // Initialised EMPTY so the first client render matches the server render (and
  // the e2e fixtures still see every group); the persisted value is loaded in an
  // effect after mount. localStorage access is guarded for SSR safety.
  const DISMISSED_KEY = "lathe.overview.attn.dismissed";
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DISMISSED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setDismissed(new Set(parsed.filter((k) => typeof k === "string")));
      }
    } catch {
      /* localStorage unavailable (SSR / privacy mode) — keep the empty default */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
    } catch {
      /* localStorage unavailable — persistence is best-effort */
    }
  }, [dismissed]);

  const dismissGroup = (key: string) =>
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  const restoreDismissed = () => setDismissed(new Set());

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
  const scopeFindingKindCounts = useMemo(
    () => countFindingKindsForSessionScope(findingKindSessionRefs, scopeSessions.map((s) => s.id)),
    [findingKindSessionRefs, scopeSessions],
  );

  const attentionEmpty =
    costAlerts.length === 0 && errorSessions.length === 0 && pendingSessions.length === 0;

  // The WorkareaHeader meta (left, beside the title): the active scope label
  // (overview-scope-label, reflecting ?project=) plus the lead-in to the panels.
  // The two keep their original testid split from the old self-drawn band — the
  // scope rides on `overview-scope-label`, and `sessbar-meta` stays the static
  // lead-in — so a project selection updates the scope label without `sessbar-meta`
  // ever reading "All projects" (the e2e scope-label contract is unchanged).
  const meta = (
    <>
      <span className="lds-session-bar-scope" data-testid="overview-scope-label">{scopeLabel}</span>
      <span className="lds-meta-sep" aria-hidden="true"> · </span>
      <span className="lds-session-bar-scope" data-testid="overview-session-class-label">
        {sessionClassLabel(activeSessionClass)} sessions
      </span>
      <span className="lds-meta-sep" aria-hidden="true"> · </span>
      <span data-testid="sessbar-meta">attention items, then the cross-session breakdown</span>
    </>
  );

  // The WorkareaHeader actions (right): the scope totals (sessions / duration /
  // tokens / cost / cost outliers), unchanged kstats moved off the self-drawn
  // band onto the shell-owned header. Project SCOPE is not a control here — it
  // moved to the shell TopBar selector (?project=), which this view reads.
  const actions = (
    <>
      <Select
        value={activeSessionClass}
        options={SESSION_CLASS_OPTIONS}
        onChange={(e) => updateSessionClass(e.target.value as SessionClassFilter)}
        data-testid="overview-session-class-filter"
        title="Filter sessions by class"
      />
      <span className="lds-sv-stats" data-testid="sessbar-stats">
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
      </span>
    </>
  );

  return (
    // The Overview no longer draws its own .lds-session-bar band: the shell-owned
    // Surface WorkareaHeader carries the title + scope meta + totals (and the
    // `sessbar` testid via headerTestId), so the analysis canvas starts flush
    // under one uniform header — no self-drawn header step (Layout v2, slice 4).
    <Surface
      surface="overview"
      headerTestId="sessbar"
      title={<span data-testid="sessbar-title">Overview</span>}
      meta={meta}
      actions={actions}
    >
      <div className="overview-page" data-testid="overview-page">
      {/* Full-width analysis canvas — no rail. */}
      <div className="overview-canvas" data-testid="overview-canvas" data-overview-version="2">
        {/* ======================= Attention (the lead panel) ======================= */}
        <section className="attn-panel" data-testid="attn-panel" data-panel="attention">
          <div className="attn-head" data-testid="attn-head">
            <span className="attn-title" data-testid="attn-title">NEEDS ATTENTION</span>
            <span className="attn-head-right">
              {dismissed.size > 0 && (
                <Pressable
                  type="button"
                  className="attn-restore" data-testid="attn-restore"
                  onClick={restoreDismissed}
                  title="Show the columns you hid"
                >
                  restore hidden ({dismissed.size})
                </Pressable>
              )}
              <span className="muted small" data-testid="muted">{scopeLabel}</span>
            </span>
          </div>

          {attentionEmpty ? (
            <div className="empty attn-empty" data-testid="empty">
              No cost outliers, errors, or pending findings in this scope.
            </div>
          ) : (
            <div className="attn-cols" data-testid="attn-cols">
              {/* ① G9 cost outliers */}
              {!dismissed.has("cost") && (
              <div className="attn-col" data-testid="attn-col" data-attn-group="cost">
                <div
                  className="attn-col-head" data-testid="attn-col-head"
                  title="G9: cost > 5× runner median, min $50"
                >
                  <span>COST OUTLIERS</span>
                  <span className="attn-col-basis mono" data-testid="attn-col-basis">&gt;5× runner median, min $50 (G9)</span>
                  <span className="attn-count mono" data-testid="attn-count">{costAlerts.length}</span>
                  <Pressable
                    type="button"
                    className="attn-col-close" data-testid="attn-col-close" data-col="cost"
                    onClick={() => dismissGroup("cost")}
                    title="Hide this column" aria-label="Hide cost outliers column"
                  >×</Pressable>
                </div>
                {costAlerts.length === 0 ? (
                  <div className="attn-none" data-testid="attn-none">none</div>
                ) : (
                  costAlerts.map(({ session: s, ratio }) => (
                    <Link
                      key={s.id}
                      href={sessionHref(s.id, activeSessionClass)}
                      className="attn-row" data-testid="attn-row"
                      data-session-id={s.id}
                    >
                      <span className="attn-row-title" data-testid="attn-row-title" data-ellipsis-ok title={s.title}>{s.title}</span>
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
              )}

              {/* ② error-heavy sessions */}
              {!dismissed.has("errors") && (
              <div className="attn-col" data-testid="attn-col" data-attn-group="errors">
                <div
                  className="attn-col-head" data-testid="attn-col-head"
                  title="Sessions ranked by failed tool calls (descending)"
                >
                  <span>MOST ERRORS</span>
                  <span className="attn-col-basis mono" data-testid="attn-col-basis">by failed tool calls</span>
                  <span className="attn-count mono" data-testid="attn-count">{errorSessions.length}</span>
                  <Pressable
                    type="button"
                    className="attn-col-close" data-testid="attn-col-close" data-col="errors"
                    onClick={() => dismissGroup("errors")}
                    title="Hide this column" aria-label="Hide most errors column"
                  >×</Pressable>
                </div>
                {errorSessions.length === 0 ? (
                  <div className="attn-none" data-testid="attn-none">none</div>
                ) : (
                  errorSessions.map((s) => (
                    <Link
                      key={s.id}
                      href={sessionHref(s.id, activeSessionClass)}
                      className="attn-row" data-testid="attn-row"
                      data-session-id={s.id}
                    >
                      <span className="attn-row-title" data-testid="attn-row-title" data-ellipsis-ok title={s.title}>{s.title}</span>
                      <span className="attn-row-meta" data-testid="attn-row-meta">
                        <span className="badge err" data-testid="badge">{s.errorCount} err</span>
                      </span>
                    </Link>
                  ))
                )}
              </div>
              )}

              {/* ③ pending findings */}
              {!dismissed.has("findings") && (
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
                  <Pressable
                    type="button"
                    className="attn-col-close" data-testid="attn-col-close" data-col="findings"
                    onClick={() => dismissGroup("findings")}
                    title="Hide this column" aria-label="Hide pending findings column"
                  >×</Pressable>
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
                      <span className="attn-row-title" data-testid="attn-row-title" data-ellipsis-ok title={s.title}>{s.title}</span>
                      <span className="attn-row-meta" data-testid="attn-row-meta">
                        <span className="badge neutral" data-testid="badge">{pending} pending</span>
                      </span>
                    </Link>
                  ))
                )}
              </div>
              )}
            </div>
          )}
        </section>

        <OverviewTrends
          scopeSessions={scopeSessions}
          findingKindCounts={scopeFindingKindCounts}
          periodHref={(fromDay, toDay) => sessionsHrefForPeriod(fromDay, toDay, activeSessionClass)}
        />
      </div>
      </div>
    </Surface>
  );
}
