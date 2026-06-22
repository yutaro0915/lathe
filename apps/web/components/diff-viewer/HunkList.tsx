"use client";

import { useEffect, useRef, useState } from "react";
import { fmtInt } from "@lathe/shared";
import type { DiffHunk } from "@/lib/types";
import { HUNK_LINE_CAP, HUNK_PAGE, hunkStart, lineClass } from "./model";

// HunkList — the UNIFIED-ONLY hunk renderer (D15: side-by-side dropped — it dies
// at narrow width). Extracted from the retired DiffPane so BOTH diff axes
// (By file / By step) and BOTH hosts (standalone /diff + the slice-9 nested
// mini-session) render hunks through ONE component. It is the diff BODY: a
// data-scroll pane so long unwrapped code lines scroll horizontally inside the
// box (the no-overflow gate exempts data-scroll) instead of widening the page.
//
// Large-diff handling: only the first `window` hunks render (a "Show more hunks"
// button widens it); each hunk caps at HUNK_LINE_CAP lines (a per-hunk "show
// more lines"). So a huge file never floods the DOM.
//
// D13 (+/− coloring = the one semantic exception to D10): added lines get the
// success bg, removed lines the danger bg — CONFINED to the diff renderer, never
// leaking onto file rows or badges. Colors come from CSS tokens (.diff-line.add /
// .diff-line.del), no raw hex here.
//
// focusHunkId (D14/D21): when a findings evidence / cross-link jump targets a
// SPECIFIC hunk, that hunk is marked data-hunk-state="active" (a focus ring) and
// scrolled into view, and the window is widened so the target is rendered.
export function HunkList({ hunks, focusHunkId }: { hunks: DiffHunk[]; focusHunkId?: string }) {
  const focusIdx = focusHunkId ? hunks.findIndex((h) => h.id === focusHunkId) : -1;
  const [window, setWindow] = useState<number>(() => Math.max(HUNK_PAGE, focusIdx + 1));
  const rendered = hunks.slice(0, window);
  const more = hunks.length - rendered.length;
  const focusRef = useRef<HTMLDivElement | null>(null);

  // widen the window if the focus target sits past it, then scroll it into view.
  useEffect(() => {
    if (focusIdx >= 0) setWindow((w) => Math.max(w, focusIdx + 1));
  }, [focusIdx]);
  useEffect(() => {
    if (focusIdx >= 0 && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusIdx, window]);

  if (hunks.length === 0) {
    return (
      <div className="diff" data-testid="diff" data-scroll>
        <div className="empty" data-testid="empty" style={{ padding: 12 }}>
          No hunks.
        </div>
      </div>
    );
  }

  return (
    // Diff body intentionally scrolls horizontally (long unwrapped code lines);
    // data-scroll exempts it from the no-overflow gate.
    <div className="diff" data-testid="diff" data-scroll>
      {rendered.map((hunk) => {
        const focused = hunk.id === focusHunkId;
        return <HunkView key={hunk.id} hunk={hunk} focused={focused} focusRef={focused ? focusRef : undefined} />;
      })}
      {more > 0 && (
        <div className="diff-more" data-testid="diff-more">
          <span className="muted small" data-testid="muted">
            Showing {fmtInt(rendered.length)} of {fmtInt(hunks.length)} hunks
          </span>
          <span style={{ flex: "1 1 auto" }} />
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn"
            onClick={() => setWindow((w) => Math.min(hunks.length, w + HUNK_PAGE))}
          >
            Show {Math.min(HUNK_PAGE, more)} more hunks
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="btn"
            onClick={() => setWindow(hunks.length)}
          >
            Show all ({fmtInt(hunks.length)})
          </button>
        </div>
      )}
    </div>
  );
}

function HunkView({ hunk, focused, focusRef }: { hunk: DiffHunk; focused: boolean; focusRef?: React.RefObject<HTMLDivElement | null> }) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const { oldNo: oldStart, newNo: newStart } = hunkStart(hunk.header);
  const allLines = hunk.content.split("\n");
  const lines = expanded ? allLines : allLines.slice(0, HUNK_LINE_CAP);
  const moreLines = allLines.length - lines.length;

  return (
    <div
      ref={focusRef}
      className={`diff-hunk${focused ? " active" : ""}`}
      data-testid="diff-hunk"
      data-hunk-id={hunk.id}
      data-hunk-seq={hunk.seq}
      data-hunk-state={focused ? "active" : undefined}
    >
      <div className="diff-header" data-testid="diff-header">
        <span className="htext" data-testid="htext">{hunk.header}</span>
      </div>
      <UnifiedLines hunkId={hunk.id} lines={lines} oldStart={oldStart} newStart={newStart} />
      {moreLines > 0 && (
        <div className="diff-more-lines" data-testid="diff-more-lines">
          <button type="button" className="btn btn-sm btn-ghost" data-testid="btn" onClick={() => setExpanded(true)}>
            Show {fmtInt(moreLines)} more line{moreLines === 1 ? "" : "s"} in this hunk
          </button>
        </div>
      )}
    </div>
  );
}

function UnifiedLines({ hunkId, lines, oldStart, newStart }: { hunkId: string; lines: string[]; oldStart: number; newStart: number }) {
  let oldNo = oldStart;
  let newNo = newStart;
  return (
    <>
      {lines.map((line, li) => {
        const cls = lineClass(line);
        const text = line.length ? line.slice(1) : "";
        const oldCell = cls === "add" ? "" : String(oldNo);
        const newCell = cls === "del" ? "" : String(newNo);
        if (cls !== "add") oldNo += 1;
        if (cls !== "del") newNo += 1;
        const marker = cls === "add" ? "+" : cls === "del" ? "-" : " ";
        return (
          <div className={`diff-line${cls ? " " + cls : ""}`} data-testid="diff-line" data-line-kind={cls || "ctx"} key={`${hunkId}-${li}`}>
            <span className="lno" data-testid="lno">{oldCell}</span>
            <span className="lno" data-testid="lno">{newCell}</span>
            <span className="marker" data-testid="marker">{marker}</span>
            <span className="ltext" data-testid="ltext">{text}</span>
          </div>
        );
      })}
    </>
  );
}
