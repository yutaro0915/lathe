"use client";

// components/StatsView.tsx — the Stats tab: charts for the CURRENT SCOPE.
//
// Rendered embedded in the SessionViewer "Stats" tab. It charts the *visible
// session set* — the project the sidebar selector scoped to, plus any
// search/model/error filters — NOT a cross-project table. Project-to-project
// comparison is the job of the project selector; this tab answers, for the
// sessions you're looking at: where did the time / tokens / cost / actions go?
//
// Four dependency-free charts (inline SVG + CSS bars), all derived from the
// in-scope sessions (+ per-session event-type counts):
//   1. Cost & tokens over time (sessions in chronological order)
//   2. Cost by model
//   3. Event-type composition (Bash / Edit / Read / Sub-agent / Skill / …)
//   4. Biggest sessions by cost
// Phase-1 observation only (no AI / harness evaluation — that's Phase 2).

import Link from "next/link";
import { EVENT_COLOR, EVENT_LABEL } from "@/lib/event-display";
import { fmtCompact, fmtCost, fmtInt, shortModel } from "@lathe/shared";
import type { EventType, Session } from "@/lib/types";
function parseDate(s: string): string {
  // "2026-06-04 09:12:00" -> "Jun 4"
  const [d] = s.split(" ");
  const [, mo, da] = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[Number(mo) - 1] ?? mo} ${Number(da)}`;
}

// One bar of the "cost & tokens over time" chart — either a single session or,
// for large scopes, a calendar bucket aggregating several (so the SVG stays a
// few dozen <rect>s instead of one per session, which froze "All projects").
type TimeBar = {
  key: string;
  label: string;
  cost: number;
  costKnown: boolean;
  tokens: number;
  sessions: number;
  title: string;
  // the bar's calendar span (YYYY-MM-DD inclusive) — used to deep-link the
  // Sessions axis to "?from=&to=" so clicking a bar drills into that period.
  fromDay: string;
  toDay: string;
};

export default function StatsView({
  scopeSessions,
  eventCounts,
  scopeLabel,
  // Overview drill-down wiring (all optional). When omitted — e.g. the
  // SessionViewer "Stats" tab, which is per-session — the charts render as plain
  // read-only graphics. When supplied (the /overview canvas), each chart becomes
  // an entry point into the Sessions axis and biggest-session rows carry status.
  pendingFindings,
  modelHref,
  periodHref,
  sessionHref,
}: {
  scopeSessions: Session[];
  eventCounts: Record<string, Record<string, number>>;
  scopeLabel: string;
  pendingFindings?: Record<string, number>;
  modelHref?: (model: string) => string;
  periodHref?: (fromDay: string, toDay: string) => string;
  sessionHref?: (sessionId: string) => string;
}) {
  // chronological order for the time axis: oldest → newest. seq is assigned with
  // the most-recent session = smallest seq, so oldest-first is DESCENDING seq.
  const chrono = [...scopeSessions].sort((a, b) => b.seq - a.seq);

  // 2. cost by model
  const byModel = new Map<string, { cost: number; costKnown: boolean; tokens: number; sessions: number }>();
  for (const s of scopeSessions) {
    const k = s.model ?? "(unknown)";
    const m = byModel.get(k) ?? { cost: 0, costKnown: false, tokens: 0, sessions: 0 };
    if (s.costUsd != null) { m.cost += s.costUsd; m.costKnown = true; }
    m.tokens += s.tokenUsage ?? 0;
    m.sessions += 1;
    byModel.set(k, m);
  }
  const models = [...byModel.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  // 3. event composition (sum per-session top-level counts across the scope)
  const evAgg = new Map<string, number>();
  for (const s of scopeSessions) {
    const c = eventCounts[s.id];
    if (!c) continue;
    for (const [t, n] of Object.entries(c)) evAgg.set(t, (evAgg.get(t) ?? 0) + n);
  }
  const events = [...evAgg.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  const evTotal = events.reduce((a, e) => a + e.count, 0);

  // 4. biggest sessions by cost
  const biggest = [...scopeSessions]
    .filter((s) => s.costUsd != null)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 14);

  const maxModelCost = Math.max(1e-6, ...models.map((m) => m.cost));
  const maxEv = Math.max(1, ...events.map((e) => e.count));
  const maxBig = Math.max(1e-6, ...biggest.map((s) => s.costUsd ?? 0));

  if (scopeSessions.length === 0) {
    return (
      <div className="stats-embed" data-testid="stats-embed">
        <div className="stats-scroll" data-testid="stats-scroll">
          <div className="empty" data-testid="empty" style={{ padding: 24 }}>
            No sessions in this scope. Pick a different project (top-left) or clear the filters.
          </div>
        </div>
      </div>
    );
  }

  // Build the time-chart bars. Few sessions → one bar each (unchanged). Many →
  // aggregate into equal calendar buckets sized so the bar count stays ≤ a
  // target, keeping the SVG light no matter how big "All projects" gets.
  const BAR_TARGET = 60;
  const dayOf = (s: string) => s.slice(0, 10); // YYYY-MM-DD from ISO or space form
  const DAY_MS = 86_400_000;
  let bucketDays = 1;
  let timeBars: TimeBar[];
  if (chrono.length <= BAR_TARGET) {
    timeBars = chrono.map((s) => {
      const day = dayOf(s.startedAt);
      return {
        key: s.id,
        label: parseDate(s.startedAt),
        cost: s.costUsd ?? 0,
        costKnown: s.costUsd != null,
        tokens: s.tokenUsage ?? 0,
        sessions: 1,
        title: `${s.title}\n${parseDate(s.startedAt)} · ${fmtCost(s.costUsd)} · ${fmtCompact(s.tokenUsage)} tok`,
        fromDay: day,
        toDay: day,
      };
    });
  } else {
    // True min/max day across the scope (don't assume seq order == date order),
    // so the bucket count stays bounded by BAR_TARGET no matter the data.
    const times = chrono
      .map((s) => Date.parse(dayOf(s.startedAt)))
      .filter((t) => !Number.isNaN(t));
    const firstMs = times.length ? Math.min(...times) : 0;
    const lastMs = times.length ? Math.max(...times) : 0;
    const spanDays = Math.max(1, Math.round((lastMs - firstMs) / DAY_MS) + 1);
    bucketDays = Math.max(1, Math.ceil(spanDays / BAR_TARGET));
    const step = bucketDays * DAY_MS;
    const buckets = new Map<number, TimeBar & { startMs: number }>();
    for (const s of chrono) {
      const ms = Date.parse(dayOf(s.startedAt));
      const idx = Number.isNaN(ms) ? 0 : Math.floor((ms - firstMs) / step);
      let b = buckets.get(idx);
      if (!b) {
        b = { key: `b${idx}`, label: "", cost: 0, costKnown: false, tokens: 0, sessions: 0, title: "", fromDay: "", toDay: "", startMs: firstMs + idx * step };
        buckets.set(idx, b);
      }
      if (s.costUsd != null) { b.cost += s.costUsd; b.costKnown = true; }
      b.tokens += s.tokenUsage ?? 0;
      b.sessions += 1;
    }
    timeBars = [...buckets.values()]
      .sort((a, b) => a.startMs - b.startMs)
      .map(({ startMs, ...b }) => {
        const fromDay = new Date(startMs).toISOString().slice(0, 10);
        const toDay = new Date(startMs + (bucketDays - 1) * DAY_MS).toISOString().slice(0, 10);
        const start = parseDate(fromDay);
        const end = parseDate(toDay);
        const range = bucketDays === 1 ? start : `${start}–${end}`;
        return {
          ...b,
          label: start,
          fromDay,
          toDay,
          title: `${range}\n${b.sessions} session${b.sessions === 1 ? "" : "s"} · ${b.costKnown ? fmtCost(b.cost) : "—"} · ${fmtCompact(b.tokens)} tok`,
        };
      });
  }

  const maxCost = Math.max(1e-6, ...timeBars.map((b) => b.cost));
  const maxTok = Math.max(1, ...timeBars.map((b) => b.tokens));

  // cost-over-time SVG geometry (one bar per TimeBar, not per session)
  const W = 760, H = 150, pad = 4;
  const n = timeBars.length;
  const bw = (W - pad * 2) / n;
  const tokLine = timeBars
    .map((b, i) => {
      const x = pad + i * bw + bw / 2;
      const y = H - (b.tokens / maxTok) * (H - 16);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="stats-embed" data-testid="stats-embed">
      <div className="stats-scroll" data-testid="stats-scroll">
        <div className="chart-grid" data-testid="chart-grid">
          {/* 1. cost & tokens over time */}
          <section className="chart-card chart-wide" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Cost &amp; tokens over time{" "}
              <span className="muted small" data-testid="muted">
                — {scopeLabel}, {fmtInt(chrono.length)} session
                {chrono.length === 1 ? "" : "s"}
                {bucketDays > 1
                  ? `, grouped into ${n} buckets (~${bucketDays}d each)`
                  : " in order"}
              </span>
            </div>
            <div className="chart-body" data-testid="chart-body">
              <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" data-testid="chart-svg" preserveAspectRatio="none">
                {[0.25, 0.5, 0.75].map((f) => (
                  <line
                    key={f}
                    x1={0}
                    x2={W}
                    y1={H - f * (H - 16)}
                    y2={H - f * (H - 16)}
                    stroke="var(--border-faint)"
                    strokeWidth={1}
                  />
                ))}
                {timeBars.map((b, i) => {
                  const h = (b.cost / maxCost) * (H - 16);
                  const rect = (
                    <rect
                      x={pad + i * bw}
                      y={H - h}
                      width={Math.max(0.6, bw - 0.6)}
                      height={h}
                      fill="var(--chart-bar)"
                      opacity={0.85}
                    >
                      <title>{b.title}</title>
                    </rect>
                  );
                  // Drill-down: clicking a bar scopes the Sessions axis to that
                  // bar's calendar span. Plain <a> (back button returns here).
                  if (periodHref && b.fromDay && b.toDay) {
                    return (
                      <a
                        key={b.key}
                        href={periodHref(b.fromDay, b.toDay)}
                        className="time-bar-link" data-testid="time-bar-link"
                        data-from={b.fromDay}
                        data-to={b.toDay}
                      >
                        {rect}
                      </a>
                    );
                  }
                  return <g key={b.key}>{rect}</g>;
                })}
                {n > 1 && (
                  <polyline points={tokLine} fill="none" stroke="var(--chart-line)" strokeWidth={1.3} opacity={0.9} />
                )}
              </svg>
            </div>
            <div className="chart-legend" data-testid="chart-legend">
              <span><i style={{ background: "var(--chart-bar)" }} />cost (bars)</span>
              <span><i style={{ background: "var(--chart-line)" }} />tokens (line)</span>
              <span className="spacer" data-testid="spacer" style={{ flex: 1 }} />
              <span>{parseDate(chrono[0].startedAt)} → {parseDate(chrono[chrono.length - 1].startedAt)} · peak {fmtCost(maxCost)} / {fmtCompact(maxTok)} tok</span>
            </div>
          </section>

          {/* 2. cost by model — each row drills into the Sessions axis filtered
              to that model (deep link to the sidebar MODEL filter). */}
          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">Cost by model</div>
            <div className="chart-body bars" data-testid="chart-body">
              {models.map((m) => {
                const inner = (
                  <>
                    <span className="hbar-label mono" data-testid="hbar-label" data-ellipsis-ok title={`${m.name} · ${m.sessions} ses · ${fmtCompact(m.tokens)} tok`}>
                      {shortModel(m.name)}
                    </span>
                    <span className="hbar-track" data-testid="hbar-track">
                      <span className="hbar-fill" data-testid="hbar-fill" style={{ width: `${(m.cost / maxModelCost) * 100}%`, background: "var(--chart-bar)" }} />
                    </span>
                    <span className="hbar-val" data-testid="hbar-val">{m.costKnown ? fmtCost(m.cost) : "—"}</span>
                  </>
                );
                // link only for real models; "(unknown)" has no model filter value.
                if (modelHref && m.name !== "(unknown)") {
                  return (
                    <Link key={m.name} href={modelHref(m.name)} className="hbar-row hbar-link" data-testid="hbar-link" data-model={m.name}>
                      {inner}
                    </Link>
                  );
                }
                return (
                  <div className="hbar-row" data-testid="hbar-row" key={m.name}>
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 3. event composition */}
          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Where the actions went <span className="muted small" data-testid="muted">— {fmtInt(evTotal)} steps</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {events.map((e) => (
                <div className="hbar-row" data-testid="hbar-row" key={e.type} title={EVENT_LABEL[e.type as EventType] ?? e.type}>
                  <span className="hbar-label" data-testid="hbar-label">{EVENT_LABEL[e.type as EventType] ?? e.type}</span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span className="hbar-fill" data-testid="hbar-fill" style={{ width: `${(e.count / maxEv) * 100}%`, background: EVENT_COLOR[e.type as EventType] ?? "var(--cat-uncertain)" }} />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">{fmtInt(e.count)}</span>
                </div>
              ))}
              {events.length === 0 && <div className="empty" data-testid="empty">No events in scope.</div>}
            </div>
          </section>

          {/* 4. biggest sessions by cost — each row carries a status chip set
              (errors / pending findings / G9 cost flag) and links to that
              session's viewer. Color is rationed: only `err` is red; pending
              findings and the cost flag stay neutral (design language rule 1). */}
          <section className="chart-card chart-wide" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Biggest sessions by cost <span className="muted small" data-testid="muted">— top {biggest.length}</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {biggest.map((s) => {
                const pending = pendingFindings?.[s.id] ?? 0;
                const status = (
                  <span className="big-status" data-testid="big-status">
                    {s.errorCount > 0 && <span className="badge err" data-testid="badge">{s.errorCount} err</span>}
                    {pending > 0 && <span className="badge neutral" data-testid="badge">{pending} pending</span>}
                    {s.costAnomaly && (
                      <span className="badge neutral" data-testid="badge" title="G9 cost anomaly flag">▲ cost</span>
                    )}
                  </span>
                );
                const inner = (
                  <>
                    <span className="hbar-label ttl big-ttl" data-testid="hbar-label" data-ellipsis-ok title={s.title}>
                      {s.title}
                      {status}
                    </span>
                    <span className="hbar-track" data-testid="hbar-track">
                      <span className="hbar-fill" data-testid="hbar-fill" style={{ width: `${((s.costUsd ?? 0) / maxBig) * 100}%`, background: "var(--chart-bar)" }} />
                    </span>
                    <span className="hbar-val" data-testid="hbar-val">{fmtCost(s.costUsd)}</span>
                  </>
                );
                if (sessionHref) {
                  return (
                    <Link key={s.id} href={sessionHref(s.id)} className="hbar-row hbar-link big-row" data-testid="big-row" data-session-id={s.id}>
                      {inner}
                    </Link>
                  );
                }
                return (
                  <div className="hbar-row big-row" data-testid="big-row" key={s.id} data-session-id={s.id}>
                    {inner}
                  </div>
                );
              })}
              {biggest.length === 0 && <div className="empty" data-testid="empty">No priceable sessions in scope.</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
