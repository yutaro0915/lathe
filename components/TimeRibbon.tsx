"use client";

// A real time ribbon for the bottom of both screens. Each event becomes a
// segment whose WIDTH is the wall-clock time until the next event — so long
// operations / waits show up as wide bands and you can see *where the time
// went*. Fills the full width, zooms in/out (scrolls when zoomed), and every
// segment hovers to reveal its duration. Derived entirely from event timestamps.

import { useMemo, useState } from "react";
import type { TranscriptEvent } from "@/lib/types";

function tsToSec(ts: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(ts || "");
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function kindOf(type: string): string {
  switch (type) {
    case "user_message":
    case "assistant_message":
      return "message";
    case "bash":
    case "test":
      return "tool";
    case "file_read":
    case "file_edit":
    case "file_write":
      return "file";
    case "skill":
      return "skill";
    case "subagent":
      return "subagent";
    case "commit":
      return "git";
    case "error":
      return "error";
    default:
      return "tool";
  }
}

function fmtDur(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function clock(absSec: number): string {
  const s = ((absSec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const LEGEND: [string, string][] = [
  ["message", "Message"],
  ["tool", "Tool / Bash"],
  ["file", "File"],
  ["subagent", "Sub-agent"],
  ["git", "Commit"],
  ["error", "Error"],
];

export default function TimeRibbon({
  events,
  selectedId,
  onSelect,
  title = "Time spent",
}: {
  events: TranscriptEvent[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  title?: string;
}) {
  const [zoom, setZoom] = useState(1);

  const model = useMemo(() => {
    // events with a parseable timestamp, in order, with midnight-rollover fixup
    const pts: { e: TranscriptEvent; abs: number }[] = [];
    let prev = -Infinity;
    let dayOffset = 0;
    for (const e of events) {
      const sec = tsToSec(e.ts);
      if (sec == null) continue;
      let abs = sec + dayOffset;
      if (abs < prev) {
        dayOffset += 86400;
        abs = sec + dayOffset;
      }
      prev = abs;
      pts.push({ e, abs });
    }
    if (pts.length === 0) return null;
    const start = pts[0].abs;
    const end = pts[pts.length - 1].abs;
    const total = Math.max(1, end - start);
    const segs = pts.map((p, i) => {
      const next = i + 1 < pts.length ? pts[i + 1].abs : p.abs;
      const dur = Math.max(0, next - p.abs);
      return { e: p.e, offset: p.abs - start, dur, pct: (dur / total) * 100 };
    });
    return { start, end, total, segs };
  }, [events]);

  if (!model) {
    return (
      <div className="ribbon">
        <div className="ribbon-head">
          <span className="mtitle">{title}</span>
          <span className="ribbon-total muted small">no timing data</span>
        </div>
      </div>
    );
  }

  const { start, total, segs } = model;
  // the single longest gap — highlighted so the biggest time sink is obvious
  const maxDur = Math.max(...segs.map((s) => s.dur));

  return (
    <div className="ribbon">
      <div className="ribbon-head">
        <span className="mtitle">{title}</span>
        <span className="ribbon-total mono">{fmtDur(total)} total</span>
        <span className="spacer" />
        <span className="minimap-legend">
          {LEGEND.map(([cls, label]) => (
            <span key={cls} className="legend-item">
              <span className={`legend-swatch ${cls}`} />
              {label}
            </span>
          ))}
        </span>
        <div className="minimap-zoom" role="group" aria-label="Zoom time ribbon">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)))}>
            −
          </button>
          <span className="mono small" style={{ minWidth: 38, textAlign: "center" }}>
            {zoom.toFixed(1)}×
          </span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(12, +(z + 0.5).toFixed(2)))}>
            +
          </button>
          <button type="button" aria-label="Fit" onClick={() => setZoom(1)}>
            ⤢
          </button>
        </div>
      </div>

      <div className="ribbon-scroll">
        <div className="ribbon-track" style={{ width: `${100 * zoom}%` }}>
          {segs.map((s, i) => {
            const isSel = s.e.id === selectedId;
            const isMax = s.dur === maxDur && s.dur > 0;
            return (
              <button
                key={`${s.e.id}-${i}`}
                type="button"
                className={`ribbon-seg ${kindOf(s.e.type)}${isSel ? " active" : ""}${isMax ? " peak" : ""}`}
                style={{ width: `max(2px, ${s.pct}%)` }}
                title={`${clock(start + s.offset)} · Turn ${s.e.seq} · ${s.e.title}\n${fmtDur(s.dur)} until next step`}
                onClick={onSelect ? () => onSelect(s.e.id) : undefined}
                tabIndex={onSelect ? 0 : -1}
              />
            );
          })}
        </div>
      </div>

      <div className="ribbon-axis">
        <span className="tick mono">{clock(start)}</span>
        <span className="tick mono">{clock(start + total / 2)}</span>
        <span className="tick mono">{clock(start + total)}</span>
      </div>
    </div>
  );
}
