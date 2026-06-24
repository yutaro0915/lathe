"use client";

// components/SessionStatsView.tsx — the Stats tab: charts for THIS SESSION.
//
// Embedded in the SessionViewer "Stats" tab. Answers "where did the time, cost
// and actions go within this run?" — never aggregates over other sessions
// (cross-session analytics live on /overview).
//
// Dependency-free SVG + CSS bars, derived from the SessionBundle:
//   1. Per-turn cost & duration (each top-level user_message is a turn)
//   2. Event-type composition (Bash / Edit / Read / Sub-agent / Skill / …)
//   3. Files touched (+ / − lines, top of the change set)
//   4. Sub-agent runs (model + cost per run, when present)
//   5. Harness signals (memory loads / hooks that fired)

import { useMemo } from "react";
import { EVENT_COLOR, EVENT_LABEL } from "@/lib/event-display";
import { basename, fmtCompact, fmtCost, fmtDuration, fmtInt, shortModel } from "@lathe/shared";
import { RunnerIcon } from "@/design-system/components";
import type { EventType, SessionBundle } from "@/lib/types";

export default function SessionStatsView({ bundle }: { bundle: SessionBundle }) {
  const { session, events, changedFiles } = bundle;

  // 1. per-turn: each top-level user_message starts a turn; collect its child
  // top-level steps (until the next user_message), summing duration & token cost.
  const turns = useMemo(() => {
    const tops = events.filter((e) => !e.parentId);
    type T = { turn: number; title: string; ts: string; steps: number; durationMs: number; tokens: number };
    const out: T[] = [];
    let cur: T | null = null;
    let n = 0;
    for (const e of tops) {
      if (e.type === "user_message") {
        if (cur) out.push(cur);
        n += 1;
        cur = {
          turn: n,
          title: e.title || `Turn ${n}`,
          ts: e.ts,
          steps: 0,
          durationMs: 0,
          tokens: 0,
        };
      } else if (cur) {
        cur.steps += 1;
        cur.durationMs += e.durationMs ?? 0;
        cur.tokens += e.tokenUsage ?? 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  }, [events]);

  // 2. event-type composition (top-level only, matching the transcript spine)
  const eventTypes = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of events) if (!e.parentId) tally.set(e.type, (tally.get(e.type) ?? 0) + 1);
    return [...tally.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [events]);
  const evTotal = eventTypes.reduce((a, e) => a + e.count, 0);

  // 3. files touched — already in the bundle, sorted by churn
  const files = useMemo(
    () =>
      [...changedFiles]
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, 14),
    [changedFiles],
  );
  const maxFileChurn = Math.max(1, ...files.map((f) => f.additions + f.deletions));

  // 4. sub-agent runs — each launcher (subagent + no parent) is one run; pull
  // model / cost / tool-count from the meta payload set by ingest.
  const subagents = useMemo(() => {
    const launchers = events.filter((e) => e.type === "subagent" && !e.parentId);
    return launchers.map((e) => {
      let model: string | undefined;
      let costUsd: number | undefined;
      let toolUses: number | undefined;
      try {
        const m = e.meta ? JSON.parse(e.meta) : {};
        if (typeof m.model === "string") model = m.model;
        if (typeof m.costUsd === "number") costUsd = m.costUsd;
        if (typeof m.toolUses === "number") toolUses = m.toolUses;
      } catch {
        /* ignore */
      }
      return {
        id: e.id,
        name: e.subagent ?? "sub-agent",
        title: e.title,
        durationMs: e.durationMs,
        tokens: e.tokenUsage ?? 0,
        model,
        costUsd,
        toolUses,
      };
    });
  }, [events]);

  // 5. harness signals: which nested memory files loaded, which hooks fired
  const memory = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of events) {
      if (e.type !== "memory" || !e.filePath) continue;
      const segs = e.filePath.split("/").filter(Boolean);
      const name = segs.length <= 2 ? e.filePath : segs.slice(-2).join("/");
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    return [...tally.entries()].map(([name, count]) => ({ name, count }));
  }, [events]);
  const hooks = useMemo(() => {
    const tally = new Map<string, number>();
    for (const e of events) {
      if (e.type !== "hook") continue;
      let ev: string | null = null, nm: string | null = null;
      try {
        const m = e.meta ? JSON.parse(e.meta) : {};
        if (typeof m.hookEvent === "string") ev = m.hookEvent;
        if (typeof m.hookName === "string") nm = m.hookName;
      } catch {
        /* ignore */
      }
      const key = ev ? (nm && nm !== ev ? `${ev} (${nm})` : ev) : nm ?? "hook";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()].map(([name, count]) => ({ name, count }));
  }, [events]);

  // chart bounds
  const maxTurnDur = Math.max(1, ...turns.map((t) => t.durationMs));
  const maxTurnTok = Math.max(1, ...turns.map((t) => t.tokens));
  const maxEv = Math.max(1, ...eventTypes.map((e) => e.count));
  const maxSubCost = Math.max(1e-6, ...subagents.map((s) => s.costUsd ?? 0));

  // SVG geometry for the per-turn chart
  const W = 760, H = 150, pad = 4;
  const n = turns.length;
  const bw = n > 0 ? (W - pad * 2) / n : 0;
  const tokLine =
    n > 1
      ? turns
          .map((t, i) => {
            const x = pad + i * bw + bw / 2;
            const y = H - (t.tokens / maxTurnTok) * (H - 16);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";

  return (
    <div className="stats-embed" data-testid="stats-embed">
      <div className="stats-scroll" data-testid="stats-scroll">
        {/* D32: per-session quantitative profile opens with a horizontal
            stat-strip (cost / tokens-io / turns / tools / errors). Color is
            rationed (D10): only the errors value is clean red (--c-error). */}
        <div className="stat-strip" data-testid="stat-strip">
          <span className="stat" data-testid="stat">
            <span className="stat-k" data-testid="stat-k">cost</span>{" "}
            <span className="stat-v" data-testid="stat-v">{fmtCost(session.costUsd)}</span>
          </span>
          <span className="stat" data-testid="stat">
            <span className="stat-k" data-testid="stat-k">tokens</span>{" "}
            <span className="stat-v" data-testid="stat-v">{fmtCompact(session.tokenUsage)}</span>{" "}
            <span className="stat-k" data-testid="stat-k">
              (in {fmtCompact(session.tokenIn)} / out {fmtCompact(session.tokenOut)})
            </span>
          </span>
          <span className="stat" data-testid="stat">
            <span className="stat-k" data-testid="stat-k">turns</span>{" "}
            <span className="stat-v" data-testid="stat-v">{fmtInt(n)}</span>
          </span>
          <span className="stat" data-testid="stat">
            <span className="stat-k" data-testid="stat-k">tools</span>{" "}
            <span className="stat-v" data-testid="stat-v">{fmtInt(session.toolCount)}</span>
          </span>
          <span className="stat" data-testid="stat-errors">
            <span className="stat-k" data-testid="stat-k">errors</span>{" "}
            <span className="stat-v stat-v-error" data-testid="stat-v">{fmtInt(session.errorCount)}</span>
          </span>
        </div>
        <div className="chart-grid" data-testid="chart-grid">
          {/* 1. per-turn cost (duration as bars, tokens as line) */}
          <section className="chart-card chart-wide" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Where this session went{" "}
              <span className="muted small" data-testid="muted">
                — {fmtInt(n)} turn{n === 1 ? "" : "s"} · session total {fmtCost(session.costUsd)} · {fmtCompact(session.tokenUsage)} tok
              </span>
            </div>
            {n === 0 ? (
              <div className="empty" data-testid="empty">No user turns.</div>
            ) : (
              <>
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
                    {turns.map((t, i) => {
                      const h = (t.durationMs / maxTurnDur) * (H - 16);
                      return (
                        <rect
                          key={t.turn}
                          x={pad + i * bw}
                          y={H - h}
                          width={Math.max(0.6, bw - 0.6)}
                          height={h}
                          fill="var(--chart-bar)"
                          opacity={0.85}
                        >
                          <title>{`Turn ${t.turn}\n${t.title}\n${fmtDuration(t.durationMs)} · ${t.steps} steps · ${fmtCompact(t.tokens)} tok`}</title>
                        </rect>
                      );
                    })}
                    {n > 1 && (
                      <polyline points={tokLine} fill="none" stroke="var(--chart-line)" strokeWidth={1.3} opacity={0.9} />
                    )}
                  </svg>
                </div>
                <div className="chart-legend" data-testid="chart-legend">
                  <span><i style={{ background: "var(--chart-bar)" }} />duration (bars)</span>
                  <span><i style={{ background: "var(--chart-line)" }} />tokens (line)</span>
                  <span style={{ flex: 1 }} />
                  <span>peak {fmtDuration(maxTurnDur)} / {fmtCompact(maxTurnTok)} tok</span>
                </div>
              </>
            )}
          </section>

          {/* 2. event composition (this session, top-level only) */}
          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Where the actions went <span className="muted small" data-testid="muted">— {fmtInt(evTotal)} steps</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {eventTypes.map((e) => (
                <div className="hbar-row" data-testid="hbar-row" key={e.type} title={EVENT_LABEL[e.type as EventType] ?? e.type}>
                  <span className="hbar-label" data-testid="hbar-label">{EVENT_LABEL[e.type as EventType] ?? e.type}</span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className="hbar-fill" data-testid="hbar-fill"
                      style={{
                        width: `${(e.count / maxEv) * 100}%`,
                        background: EVENT_COLOR[e.type as EventType] ?? "var(--cat-uncertain)",
                      }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">{fmtInt(e.count)}</span>
                </div>
              ))}
              {eventTypes.length === 0 && <div className="empty" data-testid="empty">No events.</div>}
            </div>
          </section>

          {/* 3. files touched */}
          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Files touched <span className="muted small" data-testid="muted">— top {files.length}</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {files.map((f) => (
                <div className="hbar-row" data-testid="hbar-row" key={f.id} title={f.path}>
                  <span className="hbar-label" data-testid="hbar-label">{basename(f.path)}</span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className="hbar-fill" data-testid="hbar-fill"
                      style={{
                        width: `${((f.additions + f.deletions) / maxFileChurn) * 100}%`,
                        background: "var(--chart-bar)",
                      }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">
                    <span style={{ color: "var(--muted)" }}>+{f.additions}</span>{" "}
                    <span style={{ color: "var(--muted)" }}>−{f.deletions}</span>
                  </span>
                </div>
              ))}
              {files.length === 0 && <div className="empty" data-testid="empty">No file changes.</div>}
            </div>
          </section>

          {/* 4. sub-agent runs */}
          <section className="chart-card chart-wide" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Sub-agent runs{" "}
              <span className="muted small" data-testid="muted">— {fmtInt(subagents.length)} run{subagents.length === 1 ? "" : "s"}</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {subagents.map((s) => (
                <div className="hbar-row" data-testid="hbar-row" key={s.id} title={`${s.name} · ${s.toolUses ?? "?"} tools`}>
                  <span className="hbar-label" data-testid="hbar-label">
                    {/* D4: runner icon (sub-agents run under this session's
                        runner) + name; replaces the bare text label. */}
                    <RunnerIcon runner={session.runner} size={16} style={{ marginRight: 6, verticalAlign: "-4px" }} />
                    {s.name}
                    {s.model && (
                      <span className="muted small mono" data-testid="muted" style={{ marginLeft: 6 }}>
                        {shortModel(s.model, "(unknown)")}
                      </span>
                    )}
                  </span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className="hbar-fill" data-testid="hbar-fill"
                      style={{
                        width: `${((s.costUsd ?? 0) / maxSubCost) * 100}%`,
                        background: "var(--cat-subagent)",
                      }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">
                    {s.costUsd != null ? fmtCost(s.costUsd) : "—"}
                    <span className="muted small" data-testid="muted" style={{ marginLeft: 6 }}>
                      {fmtDuration(s.durationMs)}
                    </span>
                  </span>
                </div>
              ))}
              {subagents.length === 0 && <div className="empty" data-testid="empty">No sub-agent runs in this session.</div>}
            </div>
          </section>

          {/* 5. harness signals */}
          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Memory loaded <span className="muted small" data-testid="muted">— nested CLAUDE.md / AGENTS.md ({memory.length})</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {memory.map((m) => (
                <div className="hbar-row" data-testid="hbar-row" key={m.name} title={m.name}>
                  <span className="hbar-label mono" data-testid="hbar-label">{m.name}</span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className="hbar-fill" data-testid="hbar-fill"
                      style={{
                        width: `${(m.count / Math.max(1, ...memory.map((x) => x.count))) * 100}%`,
                        background: "var(--cat-git)",
                      }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">{fmtInt(m.count)}×</span>
                </div>
              ))}
              {memory.length === 0 && <div className="empty" data-testid="empty">No nested memory loaded.</div>}
            </div>
          </section>

          <section className="chart-card" data-testid="chart-card">
            <div className="chart-h" data-testid="chart-h">
              Hooks fired <span className="muted small" data-testid="muted">— ({hooks.length})</span>
            </div>
            <div className="chart-body bars" data-testid="chart-body">
              {hooks.map((h) => (
                <div className="hbar-row" data-testid="hbar-row" key={h.name} title={h.name}>
                  <span className="hbar-label mono" data-testid="hbar-label">{h.name}</span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className="hbar-fill" data-testid="hbar-fill"
                      style={{
                        width: `${(h.count / Math.max(1, ...hooks.map((x) => x.count))) * 100}%`,
                        background: "var(--cat-uncertain)",
                      }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">{fmtInt(h.count)}×</span>
                </div>
              ))}
              {hooks.length === 0 && <div className="empty" data-testid="empty">No hooks.</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
