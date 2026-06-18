"use client";

import { fmtInt } from "@lathe/shared";
import type { Attribution, AttributionMethod, ChangedFile, Confidence, DiffHunk, LinkedEvent } from "@/lib/types";
import {
  HUNK_LINE_CAP,
  HUNK_PAGE,
  hunkStart,
  lineClass,
  methodLabel,
  type ViewMode,
} from "./model";

export function DiffPane({
  active,
  hunks,
  renderedHunks,
  moreHunks,
  hunkAttr,
  hunkRefs,
  hunkIndex,
  selected,
  showAllHunks,
  viewMode,
  touchedSteps,
  expandedHunks,
  onSetShowAllHunks,
  onSetViewMode,
  onSetSelectedLinkedEventId,
  onJumpToEvent,
  onGotoHunk,
  onExpandHunk,
  onSetHunkWindow,
}: {
  active: ChangedFile | undefined;
  hunks: DiffHunk[];
  renderedHunks: DiffHunk[];
  moreHunks: number;
  hunkAttr: Map<string, Attribution | undefined>;
  hunkRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  hunkIndex: number;
  selected: LinkedEvent | undefined;
  showAllHunks: boolean;
  viewMode: ViewMode;
  touchedSteps: LinkedEvent[];
  expandedHunks: Set<string>;
  onSetShowAllHunks: (value: boolean) => void;
  onSetViewMode: (value: ViewMode) => void;
  onSetSelectedLinkedEventId: (id: string) => void;
  onJumpToEvent?: (eventId: string) => void;
  onGotoHunk: (next: number) => void;
  onExpandHunk: (id: string) => void;
  onSetHunkWindow: React.Dispatch<React.SetStateAction<number>>;
}) {
  return (
    <div className="lds-layout-main" data-testid="main">
      <div className="diff-wrap" data-testid="diff-wrap">
        <DiffToolbar
          active={active}
          hunks={hunks}
          selected={selected}
          showAllHunks={showAllHunks}
          viewMode={viewMode}
          onSetShowAllHunks={onSetShowAllHunks}
          onSetViewMode={onSetViewMode}
        />
        {touchedSteps.length > 0 && (
          <div className="file-touched-steps" data-testid="file-touched-steps">
            <span className="muted small" data-testid="muted">Touched steps</span>
            {touchedSteps.map((le) => (
              <button
                key={le.event.id}
                type="button"
                className="file-touched-step"
                data-testid="file-touched-step"
                onClick={() => {
                  onSetSelectedLinkedEventId(le.event.id);
                  if (onJumpToEvent) onJumpToEvent(le.event.id);
                }}
                title={le.event.title}
              >
                step {le.event.seq}
              </button>
            ))}
          </div>
        )}
        <HunkNav hunks={hunks} hunkIndex={hunkIndex} onGotoHunk={onGotoHunk} />
        {/* Diff body intentionally scrolls horizontally (long unwrapped code
            lines); data-scroll exempts it from the no-overflow gate. */}
        <div className="diff" data-testid="diff" data-scroll>
          {renderedHunks.map((hunk, index) => (
            <HunkView
              key={hunk.id}
              hunk={hunk}
              index={index}
              hunkRefs={hunkRefs}
              attr={hunkAttr.get(hunk.id)}
              hunkIndex={hunkIndex}
              selected={selected}
              showAllHunks={showAllHunks}
              viewMode={viewMode}
              expanded={expandedHunks.has(hunk.id)}
              onSetSelectedLinkedEventId={onSetSelectedLinkedEventId}
              onExpandHunk={onExpandHunk}
            />
          ))}
          {moreHunks > 0 && (
            <div className="diff-more" data-testid="diff-more">
              <span className="muted small" data-testid="muted">
                Showing {fmtInt(renderedHunks.length)} of {fmtInt(hunks.length)} hunks
              </span>
              <span style={{ flex: "1 1 auto" }} />
              <button
                type="button"
                className="btn btn-sm"
                data-testid="btn"
                onClick={() => onSetHunkWindow((w) => Math.min(hunks.length, w + HUNK_PAGE))}
              >
                Show {Math.min(HUNK_PAGE, moreHunks)} more
              </button>
              <button type="button" className="btn btn-sm btn-ghost" data-testid="btn" onClick={() => onSetHunkWindow(hunks.length)}>
                Show all ({fmtInt(hunks.length)})
              </button>
            </div>
          )}
          {hunks.length === 0 && (
            <div className="empty" data-testid="empty" style={{ padding: 16 }}>
              No hunks.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffToolbar({
  active,
  hunks,
  selected,
  showAllHunks,
  viewMode,
  onSetShowAllHunks,
  onSetViewMode,
}: {
  active: ChangedFile | undefined;
  hunks: DiffHunk[];
  selected: LinkedEvent | undefined;
  showAllHunks: boolean;
  viewMode: ViewMode;
  onSetShowAllHunks: (value: boolean) => void;
  onSetViewMode: (value: ViewMode) => void;
}) {
  return (
    <div className="diff-toolbar" data-testid="diff-toolbar">
      <span className="fpath" data-testid="fpath">{active ? active.path : "—"}</span>
      <span className="fstats" data-testid="fstats">
        <span className="add" data-testid="add">{active ? active.additions : 0} additions</span>
        {" / "}
        <span className="del" data-testid="del">{active ? active.deletions : 0} deletions</span>
      </span>
      <span className="spacer" data-testid="spacer" />
      {selected && hunks.length > 1 && (
        <span className="segmented step-filter" data-testid="step-filter" title="Focus the selected step's change, or show the whole file">
          <button type="button" role="tab" aria-selected={!showAllHunks} className={!showAllHunks ? "active" : ""} onClick={() => onSetShowAllHunks(false)}>
            This step
          </button>
          <button type="button" role="tab" aria-selected={showAllHunks} className={showAllHunks ? "active" : ""} onClick={() => onSetShowAllHunks(true)}>
            All changes
          </button>
        </span>
      )}
      <span className="segmented" data-testid="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={viewMode === "unified"} className={viewMode === "unified" ? "active" : ""} onClick={() => onSetViewMode("unified")}>
          Unified
        </button>
        <button type="button" role="tab" aria-selected={viewMode === "split"} className={viewMode === "split" ? "active" : ""} onClick={() => onSetViewMode("split")}>
          Split
        </button>
      </span>
    </div>
  );
}

function HunkNav({
  hunks,
  hunkIndex,
  onGotoHunk,
}: {
  hunks: DiffHunk[];
  hunkIndex: number;
  onGotoHunk: (next: number) => void;
}) {
  return (
    <div className="hunk-nav" data-testid="hunk-nav">
      <button type="button" className="nav-btn" data-testid="nav-btn" aria-label="prev hunk" onClick={() => onGotoHunk(hunkIndex - 1)} disabled={hunks.length === 0 || hunkIndex === 0}>
        ‹
      </button>
      <button type="button" className="nav-btn" data-testid="nav-btn" aria-label="next hunk" onClick={() => onGotoHunk(hunkIndex + 1)} disabled={hunks.length === 0 || hunkIndex >= hunks.length - 1}>
        ›
      </button>
      <span className="pos" data-testid="pos">
        {hunks.length === 0 ? 0 : hunkIndex + 1} of {hunks.length}
      </span>
      <span style={{ flex: "1 1 auto" }} />
      <span>
        Hunk {hunks.length === 0 ? 0 : hunkIndex + 1} of {hunks.length}
      </span>
    </div>
  );
}

function HunkView({
  hunk,
  index,
  hunkRefs,
  attr,
  hunkIndex,
  selected,
  showAllHunks,
  viewMode,
  expanded,
  onSetSelectedLinkedEventId,
  onExpandHunk,
}: {
  hunk: DiffHunk;
  index: number;
  hunkRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  attr: Attribution | undefined;
  hunkIndex: number;
  selected: LinkedEvent | undefined;
  showAllHunks: boolean;
  viewMode: ViewMode;
  expanded: boolean;
  onSetSelectedLinkedEventId: (id: string) => void;
  onExpandHunk: (id: string) => void;
}) {
  const conf: Confidence = attr ? attr.confidence : "unattributed";
  const method: AttributionMethod = attr ? attr.method : "dirty_worktree";
  const linked = attr != null && attr.eventId != null;
  const { oldNo: oldStart, newNo: newStart } = hunkStart(hunk.header);
  const allLines = hunk.content.split("\n");
  const lines = expanded ? allLines : allLines.slice(0, HUNK_LINE_CAP);
  const moreLines = allLines.length - lines.length;
  const isCurrent = index === hunkIndex;
  const hunkEventId = attr?.eventId ?? null;

  if (!showAllHunks && selected != null && hunkEventId !== selected.event.id) {
    const adds = lines.filter((line) => line.startsWith("+")).length;
    const dels = lines.filter((line) => line.startsWith("-")).length;
    return (
      <div
        className="diff-hunk collapsed"
        data-testid="diff-hunk"
        data-hunk-id={hunk.id}
        data-hunk-seq={hunk.seq}
        data-hunk-state="collapsed"
        role="button"
        tabIndex={0}
        onClick={() => hunkEventId && onSetSelectedLinkedEventId(hunkEventId)}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && hunkEventId) {
            event.preventDefault();
            onSetSelectedLinkedEventId(hunkEventId);
          }
        }}
        title="Change from another step — click to focus it (or use All changes)"
      >
        <span className="htext" data-testid="htext">{hunk.header}</span>
        <span className="collapsed-note" data-testid="collapsed-note">+{adds} −{dels} · another step&apos;s change — click to view</span>
      </div>
    );
  }

  return (
    <div
      className={`diff-hunk${isCurrent ? " active" : ""}`}
      data-testid="diff-hunk"
      data-hunk-id={hunk.id}
      data-hunk-seq={hunk.seq}
      data-hunk-state={isCurrent ? "active" : "expanded"}
      ref={(el) => {
        hunkRefs.current[index] = el;
      }}
      style={isCurrent ? { boxShadow: "inset 0 0 0 2px var(--accent-ring)" } : undefined}
    >
      <div className="diff-header" data-testid="diff-header">
        <span className="htext" data-testid="htext">{hunk.header}</span>
        <span className="le-right" data-testid="le-right">
          <span className={`confidence ${conf}`} data-testid="confidence">{methodLabel(method)}</span>
          <span style={{ color: "var(--muted-2)" }}>⋯</span>
        </span>
      </div>
      {viewMode === "unified" ? (
        <UnifiedLines hunkId={hunk.id} lines={lines} linked={linked} oldStart={oldStart} newStart={newStart} />
      ) : (
        <SplitLines hunkId={hunk.id} lines={lines} linked={linked} oldStart={oldStart} newStart={newStart} />
      )}
      {moreLines > 0 && (
        <div className="diff-more-lines" data-testid="diff-more-lines">
          <button type="button" className="btn btn-sm btn-ghost" data-testid="btn" onClick={() => onExpandHunk(hunk.id)}>
            Show {fmtInt(moreLines)} more line{moreLines === 1 ? "" : "s"} in this hunk
          </button>
        </div>
      )}
    </div>
  );
}

function UnifiedLines({ hunkId, lines, linked, oldStart, newStart }: { hunkId: string; lines: string[]; linked: boolean; oldStart: number; newStart: number }) {
  let oldNo = oldStart;
  let newNo = newStart;
  return lines.map((line, li) => {
    const cls = lineClass(line);
    const text = line.length ? line.slice(1) : "";
    const oldCell = cls === "add" ? "" : String(oldNo);
    const newCell = cls === "del" ? "" : String(newNo);
    if (cls !== "add") oldNo += 1;
    if (cls !== "del") newNo += 1;
    const marker = cls === "add" ? "+" : cls === "del" ? "-" : " ";
    const showNode = linked && li === 0;
    return (
      <div className={`diff-line${cls ? " " + cls : ""}${linked ? " linked" : ""}`} data-testid="diff-line" key={`${hunkId}-${li}`}>
        <span className="lno" data-testid="lno">{oldCell}</span>
        <span className="lno diff-gutter" data-testid="lno">
          {newCell}
          {showNode && <span className="diff-attr-node" data-testid="diff-attr-node" />}
        </span>
        <span className="marker" data-testid="marker">{marker}</span>
        <span className="ltext" data-testid="ltext">{text}</span>
      </div>
    );
  });
}

function SplitLines({ hunkId, lines, linked, oldStart, newStart }: { hunkId: string; lines: string[]; linked: boolean; oldStart: number; newStart: number }) {
  type Side = { no: number | null; text: string; cls: "" | "del" };
  type SideR = { no: number | null; text: string; cls: "" | "add" };
  const leftRows: Side[] = [];
  const rightRows: SideR[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  for (const line of lines) {
    const cls = lineClass(line);
    const text = line.length ? line.slice(1) : "";
    if (cls === "del") {
      leftRows.push({ no: oldNo, text, cls: "del" });
      oldNo += 1;
    } else if (cls === "add") {
      rightRows.push({ no: newNo, text, cls: "add" });
      newNo += 1;
    } else {
      while (leftRows.length < rightRows.length) leftRows.push({ no: null, text: "", cls: "" });
      while (rightRows.length < leftRows.length) rightRows.push({ no: null, text: "", cls: "" });
      leftRows.push({ no: oldNo, text, cls: "" });
      rightRows.push({ no: newNo, text, cls: "" });
      oldNo += 1;
      newNo += 1;
    }
  }
  while (leftRows.length < rightRows.length) leftRows.push({ no: null, text: "", cls: "" });
  while (rightRows.length < leftRows.length) rightRows.push({ no: null, text: "", cls: "" });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
      <div style={{ borderRight: "1px solid var(--border)" }}>
        {leftRows.map((left, ri) => (
          <div className={`diff-line${left.cls ? " " + left.cls : ""}`} data-testid="diff-line" key={`L-${hunkId}-${ri}`} style={{ gridTemplateColumns: "44px 16px 1fr" }}>
            <span className="lno" data-testid="lno">{left.no != null ? left.no : ""}</span>
            <span className="marker" data-testid="marker">{left.cls === "del" ? "-" : " "}</span>
            <span className="ltext" data-testid="ltext">{left.text}</span>
          </div>
        ))}
      </div>
      <div>
        {rightRows.map((right, ri) => {
          const showNode = linked && ri === 0;
          return (
            <div className={`diff-line${right.cls ? " " + right.cls : ""}${linked ? " linked" : ""}`} data-testid="diff-line" key={`R-${hunkId}-${ri}`} style={{ gridTemplateColumns: "44px 16px 1fr" }}>
              <span className="lno diff-gutter" data-testid="lno">
                {right.no != null ? right.no : ""}
                {showNode && <span className="diff-attr-node" data-testid="diff-attr-node" />}
              </span>
              <span className="marker" data-testid="marker">{right.cls === "add" ? "+" : " "}</span>
              <span className="ltext" data-testid="ltext">{right.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
