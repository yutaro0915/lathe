"use client";

// components/SessionSidebar.tsx — the left session-navigator, shared so screens
// other than the main viewer (e.g. /stats) keep the SAME shell instead of being
// a jarring standalone page. Search + sort + the session list; clicking a
// session navigates to the viewer. (The viewer has its own richer sidebar with
// transcript-specific event-type filters; this is the common navigator part.)

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session, Runner } from "@/lib/types";

function humanizeDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
function fmtCost(c: number | null): string {
  if (c == null) return "—";
  if (c > 0 && c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}
function parseStamp(s: string): { date: string; time: string } {
  const [datePart, timePart = ""] = s.split(" ");
  const [, mo, da] = datePart.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const moName = months[Number(mo) - 1] ?? mo;
  return { date: `${moName} ${Number(da)}`, time: timePart.slice(0, 5) };
}
const RUNNER_LABEL: Record<Runner, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

type SortKey = "recent" | "oldest" | "tokens";

export default function SessionSidebar({
  sessions,
  currentId,
  project,
}: {
  sessions: Session[];
  currentId?: string;
  project?: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("recent");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
    list = [...list];
    if (sortKey === "recent") list.sort((a, b) => a.seq - b.seq);
    else if (sortKey === "oldest") list.sort((a, b) => b.seq - a.seq);
    else if (sortKey === "tokens") list.sort((a, b) => b.tokenUsage - a.tokenUsage);
    return list;
  }, [sessions, search, sortKey]);

  function go(id: string) {
    router.push(`/?session=${encodeURIComponent(id)}`);
  }

  return (
    <aside className="sidebar">
      <div className="project-select">
        <span aria-hidden>⊞</span>
        <span>{project ?? sessions[0]?.project ?? "—"}</span>
        <span className="caret">⌄</span>
      </div>

      <div className="search">
        <span aria-hidden>⌕</span>
        <input
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="kbd">⌘K</span>
      </div>

      <div className="session-head">
        <span>
          <span className="title">Sessions</span>
          <span className="count">{visible.length}</span>
        </span>
        <select
          className="sort-select"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="recent">Recent first</option>
          <option value="oldest">Oldest first</option>
          <option value="tokens">Most tokens</option>
        </select>
      </div>

      <div className="sidebar-scroll">
        <div className="session-list">
          {visible.map((s) => {
            const st = parseStamp(s.startedAt);
            const active = s.id === currentId;
            return (
              <button
                key={s.id}
                type="button"
                className={`session-item${active ? " active" : ""}`}
                onClick={() => go(s.id)}
                style={{ textAlign: "left", width: "100%", font: "inherit" }}
              >
                <div className="si-top">
                  <span className="si-title">{s.title}</span>
                  {s.errorCount > 0 && (
                    <span className="badge err" title={`${s.errorCount} failed tool call(s)`}>
                      {s.errorCount} err
                    </span>
                  )}
                </div>
                <div className="si-meta">
                  <span>
                    {st.date}, {st.time}
                  </span>
                  <span className="dot">·</span>
                  <span>{humanizeDuration(s.durationMs)}</span>
                  <span className="dot">·</span>
                  <span>{s.model ?? "—"}</span>
                </div>
                <div className="si-stats">
                  <span className="runner-badge">
                    <span className={`runner-dot ${s.runner}`} />
                    {RUNNER_LABEL[s.runner]}
                  </span>
                  <span className="chip token">{fmtTok(s.tokenUsage)} tok</span>
                  <span className="chip cost">{fmtCost(s.costUsd)}</span>
                </div>
              </button>
            );
          })}
          {visible.length === 0 && (
            <div className="empty" style={{ padding: "12px" }}>
              No sessions match.
            </div>
          )}
        </div>
      </div>

      <div className="user-footer">
        <span className="avatar">YO</span>
        <span className="uname">Yutaro Ono</span>
        <span className="badge pro">Pro</span>
        <span className="gear" aria-label="Settings">
          ⚙
        </span>
      </div>
    </aside>
  );
}
