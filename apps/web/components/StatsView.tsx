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
};

export default function StatsView({
  scopeSessions,
  eventCounts,
  scopeLabel,
}: {
  scopeSessions: Session[];
  eventCounts: Record<string, Record<string, number>>;
  scopeLabel: string;
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
      <div className="stats-embed">
        <div className="stats-scroll">
          <div className="empty" style={{ padding: 24 }}>
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
    timeBars = chrono.map((s) => ({
      key: s.id,
      label: parseDate(s.startedAt),
      cost: s.costUsd ?? 0,
      costKnown: s.costUsd != null,
      tokens: s.tokenUsage ?? 0,
      sessions: 1,
      title: `${s.title}\n${parseDate(s.startedAt)} · ${fmtCost(s.costUsd)} · ${fmtCompact(s.tokenUsage)} tok`,
    }));
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
        b = { key: `b${idx}`, label: "", cost: 0, costKnown: false, tokens: 0, sessions: 0, title: "", startMs: firstMs + idx * step };
        buckets.set(idx, b);
      }
      if (s.costUsd != null) { b.cost += s.costUsd; b.costKnown = true; }
      b.tokens += s.tokenUsage ?? 0;
      b.sessions += 1;
    }
    timeBars = [...buckets.values()]
      .sort((a, b) => a.startMs - b.startMs)
      .map(({ startMs, ...b }) => {
        const start = parseDate(new Date(startMs).toISOString().slice(0, 10));
        const end = parseDate(new Date(startMs + (bucketDays - 1) * DAY_MS).toISOString().slice(0, 10));
        const range = bucketDays === 1 ? start : `${start}–${end}`;
        return {
          ...b,
          label: start,
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
    <div className="stats-embed">
      <div className="stats-scroll">
        <div className="chart-grid">
          {/* 1. cost & tokens over time */}
          <section className="chart-card chart-wide">
            <div className="chart-h">
              Cost &amp; tokens over time{" "}
              <span className="muted small">
                — {scopeLabel}, {fmtInt(chrono.length)} session
                {chrono.length === 1 ? "" : "s"}
                {bucketDays > 1
                  ? `, grouped into ${n} buckets (~${bucketDays}d each)`
                  : " in order"}
              </span>
            </div>
            <div className="chart-body">
              <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
                {timeBars.map((b, i) => {
                  const h = (b.cost / maxCost) * (H - 16);
                  return (
                    <rect
                      key={b.key}
                      x={pad + i * bw}
                      y={H - h}
                      width={Math.max(0.6, bw - 0.6)}
                      height={h}
                      fill="var(--accent)"
                      opacity={0.85}
                    >
                      <title>{b.title}</title>
                    </rect>
                  );
                })}
                {n > 1 && (
                  <polyline points={tokLine} fill="none" stroke="#10b981" strokeWidth={1.3} opacity={0.8} />
                )}
              </svg>
            </div>
            <div className="chart-legend">
              <span><i style={{ background: "var(--accent)" }} />cost (bars)</span>
              <span><i style={{ background: "#10b981" }} />tokens (line)</span>
              <span className="spacer" style={{ flex: 1 }} />
              <span>{parseDate(chrono[0].startedAt)} → {parseDate(chrono[chrono.length - 1].startedAt)} · peak {fmtCost(maxCost)} / {fmtCompact(maxTok)} tok</span>
            </div>
          </section>

          {/* 2. cost by model */}
          <section className="chart-card">
            <div className="chart-h">Cost by model</div>
            <div className="chart-body bars">
              {models.map((m) => (
                <div className="hbar-row" key={m.name}>
                  <span className="hbar-label mono" title={`${m.name} · ${m.sessions} ses · ${fmtCompact(m.tokens)} tok`}>
                    {shortModel(m.name)}
                  </span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${(m.cost / maxModelCost) * 100}%`, background: "var(--accent)" }} />
                  </span>
                  <span className="hbar-val">{m.costKnown ? fmtCost(m.cost) : "—"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 3. event composition */}
          <section className="chart-card">
            <div className="chart-h">
              Where the actions went <span className="muted small">— {fmtInt(evTotal)} steps</span>
            </div>
            <div className="chart-body bars">
              {events.map((e) => (
                <div className="hbar-row" key={e.type}>
                  <span className="hbar-label">{EVENT_LABEL[e.type as EventType] ?? e.type}</span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${(e.count / maxEv) * 100}%`, background: EVENT_COLOR[e.type as EventType] ?? "#94a3b8" }} />
                  </span>
                  <span className="hbar-val">{fmtInt(e.count)}</span>
                </div>
              ))}
              {events.length === 0 && <div className="empty">No events in scope.</div>}
            </div>
          </section>

          {/* 4. biggest sessions by cost */}
          <section className="chart-card chart-wide">
            <div className="chart-h">
              Biggest sessions by cost <span className="muted small">— top {biggest.length}</span>
            </div>
            <div className="chart-body bars">
              {biggest.map((s) => (
                <div className="hbar-row" key={s.id}>
                  <span className="hbar-label ttl" title={s.title}>{s.title}</span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${((s.costUsd ?? 0) / maxBig) * 100}%`, background: "var(--accent)" }} />
                  </span>
                  <span className="hbar-val">{fmtCost(s.costUsd)}</span>
                </div>
              ))}
              {biggest.length === 0 && <div className="empty">No priceable sessions in scope.</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
