"use client";

// A real time ribbon for the bottom of both screens. Each event becomes a
// segment whose WIDTH is the wall-clock time until the next event — so long
// operations / waits show up as wide bands and you can see *where the time
// went*. Fills the full width, zooms in/out (scrolls when zoomed).
//
// Legibility (the point of this component):
//  - HOVER anywhere on the track → a readout shows the exact clock time, the
//    event under the cursor, and how long it took. This is the reliable way to
//    read the time even when zoomed and segments are 1px slivers.
//  - CLICK anywhere → selects the event under the cursor (no need to hit a
//    2px sliver); the host scrolls its list + detail to that event.
//  - A scroll-AWARE time axis: tick labels live inside the scroll area and
//    scale with zoom, so the clock times stay readable when you zoom in.

import { useMemo, useState } from "react";
import { fmtDurationSec } from "@lathe/shared";
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
    case "thinking":
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

// clock with seconds — "13:08:47" — so zoomed-in reads are precise.
function clock(absSec: number, withSec = false): string {
  const s = ((absSec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return withSec ? `${base}:${String(sec).padStart(2, "0")}` : base;
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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

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
      <div className="ribbon" data-testid="ribbon">
        <div className="ribbon-head" data-testid="ribbon-head">
          <span className="mtitle" data-testid="mtitle">{title}</span>
          <span className="ribbon-total muted small" data-testid="ribbon-total">no timing data</span>
        </div>
      </div>
    );
  }

  const { start, total, segs } = model;
  // the single longest gap — highlighted so the biggest time sink is obvious
  const maxDur = Math.max(...segs.map((s) => s.dur));

  // Which segment is under a pointer at clientX? Walk the SAME widths the track
  // renders (max(2px, pct%)) so hover/click match what's visually under the
  // cursor even where tiny events hit the 2px floor.
  function segIndexAt(clientX: number, trackEl: HTMLElement): number {
    const rect = trackEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const w = rect.width;
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const segW = Math.max(2, (segs[i].pct / 100) * w);
      if (x < acc + segW) return i;
      acc += segW;
    }
    return segs.length - 1;
  }

  // scroll-aware time axis: more ticks as you zoom in (≈ one per 90px of track).
  const tickCount = Math.min(80, Math.max(4, Math.round(8 * zoom)));
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const f = i / tickCount;
    return { f, label: clock(start + f * total) };
  });

  const hoverSeg = hoverIdx != null ? segs[hoverIdx] : null;
  const selSeg = selectedId ? segs.find((s) => s.e.id === selectedId) : undefined;

  return (
    <div className="ribbon" data-testid="ribbon">
      <div className="ribbon-head" data-testid="ribbon-head">
        <span className="mtitle" data-testid="mtitle">{title}</span>
        <span className="ribbon-total mono" data-testid="ribbon-total">{fmtDurationSec(total)} total</span>
        {/* live readout of whatever the cursor is over — the reliable "what time / what step is this" */}
        {hoverSeg ? (
          <span className="ribbon-read mono" data-testid="ribbon-read" title={hoverSeg.e.title}>
            <b>{clock(start + hoverSeg.offset, true)}</b> · #{hoverSeg.e.seq}{" "}
            {hoverSeg.e.title.length > 44 ? hoverSeg.e.title.slice(0, 44) + "…" : hoverSeg.e.title}
            {hoverSeg.dur > 0 && <span className="muted" data-testid="muted"> · {fmtDurationSec(hoverSeg.dur)}</span>}
          </span>
        ) : (
          <span className="ribbon-read muted small" data-testid="ribbon-read">hover to read the time · click to jump</span>
        )}
        <span className="spacer" data-testid="spacer" />
        <span className="minimap-legend" data-testid="minimap-legend">
          {LEGEND.map(([cls, label]) => (
            <span key={cls} className="legend-item" data-testid="legend-item">
              <span className={`legend-swatch ${cls}`} data-testid="legend-swatch" />
              {label}
            </span>
          ))}
        </span>
        <div className="minimap-zoom" data-testid="minimap-zoom" role="group" aria-label="Zoom time ribbon">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)))}>
            −
          </button>
          <span className="mono small" data-testid="mono" style={{ minWidth: 38, textAlign: "center" }}>
            {zoom.toFixed(1)}×
          </span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(16, +(z + 0.5).toFixed(2)))}>
            +
          </button>
          <button type="button" aria-label="Fit" onClick={() => setZoom(1)}>
            ⤢
          </button>
        </div>
      </div>

      <div className="ribbon-scroll" data-testid="ribbon-scroll">
        <div
          className="ribbon-track" data-testid="ribbon-track"
          style={{ width: `${100 * zoom}%` }}
          onMouseMove={(e) => setHoverIdx(segIndexAt(e.clientX, e.currentTarget))}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={
            onSelect
              ? (e) => onSelect(segs[segIndexAt(e.clientX, e.currentTarget)].e.id)
              : undefined
          }
          role={onSelect ? "button" : undefined}
          aria-label={onSelect ? "Click to select the step at the cursor" : undefined}
        >
          {segs.map((s, i) => {
            const isSel = s.e.id === selectedId;
            const isMax = s.dur === maxDur && s.dur > 0;
            const isHov = hoverIdx === i;
            return (
              <div
                key={`${s.e.id}-${i}`}
                className={`ribbon-seg ${kindOf(s.e.type)}${isSel ? " active" : ""}${isMax ? " peak" : ""}${isHov ? " hover" : ""}`} data-testid="ribbon-seg"
                style={{ width: `max(2px, ${s.pct}%)` }}
              />
            );
          })}
          {/* playhead at the selected step */}
          {selSeg && (
            <div
              className="ribbon-playhead" data-testid="ribbon-playhead"
              style={{ left: `${(selSeg.offset / total) * 100}%` }}
              aria-hidden
            />
          )}
        </div>

        {/* scroll-aware time axis: labels scale with zoom and scroll with the track */}
        <div className="ribbon-axis" data-testid="ribbon-axis" style={{ width: `${100 * zoom}%` }}>
          {ticks.map((t, i) => {
            const isLast = i === ticks.length - 1;
            const style: React.CSSProperties = isLast
              ? { right: 0 }
              : { left: `${t.f * 100}%`, transform: i === 0 ? undefined : "translateX(-50%)" };
            return (
              <span key={i} className="tick mono" data-testid="tick" style={style}>
                {t.label}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
