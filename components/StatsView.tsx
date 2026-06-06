"use client";

// components/StatsView.tsx — the /stats page: cross-session analytics.
//
// Two things, both Phase-1 observation (no AI / harness *evaluation* — that's
// Phase 2):
//  1. Per-project (directory) stats. Sessions are grouped by their PRIMARY
//     project — the dir (projects/<slug> or a top hub dir) where the session
//     changed the most files. Click a row to drill into that project's sessions.
//  2. Light "usage" observation — which models / sub-agent types / skills ran,
//     as counts. (How well a harness works is Phase 2; this is just what ran.)

import Link from "next/link";
import { useState } from "react";
import SessionSidebar from "@/components/SessionSidebar";
import type { StatsBundle, Session } from "@/lib/types";

function humanizeDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtCost(c: number | null): string {
  if (c == null) return "—";
  if (c > 0 && c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}
// show the meaningful tail of an absolute path (the project column carries where)
function shortPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= 3) return p;
  return "…/" + segs.slice(-3).join("/");
}

export default function StatsView({
  stats,
  sessions,
}: {
  stats: StatsBundle;
  sessions: Session[];
}) {
  const { totals, projects, files, skills, subagentTypes, models } = stats;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="stats-page">
      {/* header band (matches the session-viewer sessbar) */}
      <div className="sessbar">
        <div className="sessbar-id">
          <span className="sessbar-title">Statistics</span>
          <span className="sessbar-meta">
            {projects.length} project{projects.length === 1 ? "" : "s"} · sessions grouped by the
            directory each one changed most
          </span>
        </div>
        <div className="sessbar-stats">
          <div className="kstat">
            <b>{fmtInt(totals.sessions)}</b>
            <span>sessions</span>
          </div>
          <div className="kstat">
            <b>{humanizeDuration(totals.durationMs)}</b>
            <span>duration</span>
          </div>
          <div className="kstat">
            <b>{fmtCompact(totals.tokens)}</b>
            <span>tokens</span>
          </div>
          <div className="kstat">
            <b>{fmtCost(totals.cost)}</b>
            <span>cost</span>
          </div>
        </div>
      </div>

      <div
        className="layout3"
        style={{ gridTemplateColumns: "var(--sidebar-w) minmax(0,1fr)" }}
      >
        <SessionSidebar sessions={sessions} />
        <main className="main">
          <div className="stats-scroll">
        {/* ---------- per-project ---------- */}
        <section className="stats-section">
          <div className="stats-h">
            By project{" "}
            <span className="muted small">— directory; click a row for its sessions</span>
          </div>
          <div className="stats-table">
            <div className="st-row st-head">
              <span>Project</span>
              <span className="num">Sessions</span>
              <span className="num">Duration</span>
              <span className="num">Tokens</span>
              <span className="num">Cost</span>
              <span className="num">Files</span>
              <span className="num">+ / −</span>
              <span className="num">Errors</span>
            </div>
            {projects.map((p) => {
              const isOpen = open.has(p.project);
              return (
                <div key={p.project} className="st-group">
                  <div
                    className={`st-row st-data${isOpen ? " open" : ""}`}
                    onClick={() => toggle(p.project)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(p.project);
                      }
                    }}
                  >
                    <span className="st-proj">
                      <span className="tw">{isOpen ? "▾" : "▸"}</span>
                      <span className="mono">{p.project}</span>
                    </span>
                    <span className="num">{fmtInt(p.sessions)}</span>
                    <span className="num">{humanizeDuration(p.durationMs)}</span>
                    <span className="num">{fmtCompact(p.tokens)}</span>
                    <span className="num cost">{p.costKnown ? fmtCost(p.cost) : "—"}</span>
                    <span className="num">{fmtInt(p.files)}</span>
                    <span className="num">
                      <span className="ok">+{fmtInt(p.additions)}</span>{" "}
                      <span className="err">−{fmtInt(p.deletions)}</span>
                    </span>
                    <span className="num">
                      {p.errors > 0 ? <span className="err">{fmtInt(p.errors)}</span> : "0"}
                    </span>
                  </div>
                  {isOpen && (
                    <div className="st-children">
                      {p.sessionRefs.map((s) => (
                        <Link
                          key={s.id}
                          href={`/?session=${encodeURIComponent(s.id)}`}
                          className="st-srow"
                        >
                          <span className="st-stitle">{s.title}</span>
                          <span className="muted small mono">{s.model ?? "—"}</span>
                          <span className="num">{humanizeDuration(s.durationMs)}</span>
                          <span className="num">{fmtCompact(s.tokens)}</span>
                          <span className="num cost">{fmtCost(s.cost)}</span>
                          <span className="num">
                            {s.errors > 0 ? (
                              <span className="badge err">{s.errors} err</span>
                            ) : (
                              ""
                            )}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {projects.length === 0 && <div className="empty" style={{ padding: 14 }}>No sessions.</div>}
          </div>
        </section>

        {/* ---------- by file (which files the agent worked on, traceable) ---------- */}
        <section className="stats-section">
          <div className="stats-h">
            By file{" "}
            <span className="muted small">
              — most-changed files; click a row for the sessions that touched it
            </span>
          </div>
          <div className="stats-table files-table">
            <div className="st-row st-head">
              <span>File</span>
              <span>Project</span>
              <span className="num">Sessions</span>
              <span className="num">+ / −</span>
            </div>
            {files.map((f) => {
              const key = `file:${f.path}`;
              const isOpen = open.has(key);
              return (
                <div key={f.path} className="st-group">
                  <div
                    className={`st-row st-data${isOpen ? " open" : ""}`}
                    onClick={() => toggle(key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(key);
                      }
                    }}
                  >
                    <span className="st-proj">
                      <span className="tw">{isOpen ? "▾" : "▸"}</span>
                      <span className="mono" title={f.path}>
                        {shortPath(f.path)}
                      </span>
                    </span>
                    <span className="mono small muted">{f.project}</span>
                    <span className="num">{fmtInt(f.sessions)}</span>
                    <span className="num">
                      <span className="ok">+{fmtInt(f.additions)}</span>{" "}
                      <span className="err">−{fmtInt(f.deletions)}</span>
                    </span>
                  </div>
                  {isOpen && (
                    <div className="st-children">
                      {f.sessionRefs.map((s) => (
                        <Link
                          key={s.id}
                          href={`/?session=${encodeURIComponent(s.id)}`}
                          className="st-srow"
                        >
                          <span className="st-stitle">{s.title}</span>
                          <span className="muted small mono">{s.model ?? "—"}</span>
                          <span className="num">{humanizeDuration(s.durationMs)}</span>
                          <span className="num">{fmtCompact(s.tokens)}</span>
                          <span className="num cost">{fmtCost(s.cost)}</span>
                          <span className="num">
                            {s.errors > 0 ? <span className="badge err">{s.errors} err</span> : ""}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {files.length === 0 && (
              <div className="empty" style={{ padding: 14 }}>
                No changed files.
              </div>
            )}
          </div>
        </section>

        {/* ---------- usage observation ---------- */}
        <section className="stats-section">
          <div className="stats-h">
            Usage{" "}
            <span className="muted small">
              — observation only: what scaffolding ran (harness evaluation is Phase 2)
            </span>
          </div>
          <div className="usage-grid">
            <div className="usage-card">
              <div className="uh">
                Models <span className="count">({models.length})</span>
              </div>
              {models.map((m) => (
                <div key={m.name} className="urow">
                  <span className="uname mono">{m.name}</span>
                  <span className="num">{fmtInt(m.sessions)} ses</span>
                  <span className="num">{fmtCompact(m.tokens)}</span>
                  <span className="num cost">{fmtCost(m.cost)}</span>
                </div>
              ))}
            </div>
            <div className="usage-card">
              <div className="uh">
                Sub-agent types <span className="count">({subagentTypes.length})</span>
              </div>
              {subagentTypes.length === 0 ? (
                <div className="empty">No sub-agents.</div>
              ) : (
                subagentTypes.map((s) => (
                  <div key={s.name} className="urow">
                    <span className="uname">{s.name}</span>
                    <span className="num">{fmtInt(s.count)} runs</span>
                  </div>
                ))
              )}
            </div>
            <div className="usage-card">
              <div className="uh">
                Skills <span className="count">({skills.length})</span>
              </div>
              {skills.length === 0 ? (
                <div className="empty">No skills used.</div>
              ) : (
                skills.map((s) => (
                  <div key={s.name} className="urow">
                    <span className="uname">{s.name}</span>
                    <span className="num">{fmtInt(s.count)}×</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
          </div>
        </main>
      </div>
    </div>
  );
}
