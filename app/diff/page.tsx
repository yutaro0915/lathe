export const dynamic = "force-dynamic";

import {
  getPrimarySession,
  getChangedFiles,
  getHunks,
  getAttributionsForHunk,
  getLinkedEventsForFile,
  getEvent,
  getAnnotations,
} from "@/lib/db";
import type {
  ChangedFile,
  DiffHunk,
  Attribution,
  Confidence,
  AttributionMethod,
  FileStatus,
  Annotation,
  AnnotationKind,
} from "@/lib/types";

/* ---- small presentation helpers ----------------------------------------- */

// AttributionMethod -> human label shown on .confidence chips / Event Details.
function methodLabel(method: AttributionMethod): string {
  switch (method) {
    case "edit_event":
      return "Direct edit";
    case "shell_inferred":
      return "Shell command";
    case "external":
    case "dirty_worktree":
      return "Unattributed";
  }
}

// AttributionMethod -> the "Tool" string surfaced in Event Details.
function toolForMethod(method: AttributionMethod): string {
  switch (method) {
    case "edit_event":
      return "apply_patch";
    case "shell_inferred":
      return "bash";
    case "external":
      return "external";
    case "dirty_worktree":
      return "dirty_worktree";
  }
}

// Prefer the REAL tool recorded on the event (meta.tool, e.g. "Write"/"Edit");
// fall back to a label derived from the attribution method.
function toolName(
  ev: { meta: string | null } | undefined,
  method: AttributionMethod,
): string {
  if (ev?.meta) {
    try {
      const m = JSON.parse(ev.meta);
      if (m && typeof m.tool === "string") return m.tool;
    } catch {
      /* ignore */
    }
  }
  return toolForMethod(method);
}

// Confidence -> a percent label for the linked-event row (display only).
function confidencePct(c: Confidence): string {
  switch (c) {
    case "high":
      return "98%";
    case "medium":
      return "72%";
    case "unattributed":
      return "—";
  }
}

// FileStatus -> single-glyph file icon used in the tree.
function statusGlyph(status: FileStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
  }
}

// AnnotationKind -> minimap / attr-timeline color class.
function annotationKindClass(kind: AnnotationKind): string {
  switch (kind) {
    case "edit":
      return "edit";
    case "commit":
      return "commit";
    case "test":
      return "test";
    case "error":
      return "uncertain";
    case "note":
      return "uncertain";
  }
}

// EventType -> attr-timeline chip kind (edit / command / commit / test / uncertain).
function eventKindClass(
  type: string
): "edit" | "command" | "commit" | "test" | "uncertain" {
  switch (type) {
    case "file_edit":
    case "file_write":
      return "edit";
    case "bash":
      return "command";
    case "commit":
      return "commit";
    case "test":
      return "test";
    default:
      return "uncertain";
  }
}

// Format a duration (ms) like "1.23s" for small values.
function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return fmtDuration(ms);
}

// Format a duration (ms) like "2h 47m" / "31m".
function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "1,243,000" style grouping.
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

// A diff line's class from its leading character.
function lineClass(line: string): "" | "add" | "del" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? p : p.slice(slash + 1);
}

function indentClass(depth: number): string {
  if (depth <= 0) return "";
  if (depth === 1) return "indent-1";
  if (depth === 2) return "indent-2";
  return "indent-3";
}

/* ---- file-tree assembly --------------------------------------------------- */

type TreeFile = { kind: "file"; file: ChangedFile; depth: number };
type TreeFolder = {
  kind: "folder";
  name: string;
  depth: number;
  additions: number;
  deletions: number;
};
type TreeRow = TreeFile | TreeFolder;

// Build a flat, depth-tagged render list of folder + file rows from the changed
// files: group by directory prefix and aggregate +/- onto folder header rows.
function buildTree(files: ChangedFile[]): TreeRow[] {
  const byDir = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : f.path.slice(0, slash);
    const arr = byDir.get(dir);
    if (arr) arr.push(f);
    else byDir.set(dir, [f]);
  }

  const rows: TreeRow[] = [];
  // stable order: directories sorted, root ("") last so loose files sit at bottom
  const dirs = Array.from(byDir.keys()).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  for (const dir of dirs) {
    const group = byDir.get(dir)!;
    const segments = dir === "" ? [] : dir.split("/");
    segments.forEach((seg, i) => {
      const add = group.reduce((acc, f) => acc + f.additions, 0);
      const del = group.reduce((acc, f) => acc + f.deletions, 0);
      rows.push({ kind: "folder", name: seg, depth: i, additions: add, deletions: del });
    });
    const fileDepth = segments.length;
    for (const f of group) {
      rows.push({ kind: "file", file: f, depth: fileDepth });
    }
  }
  return rows;
}

/* ---- page ----------------------------------------------------------------- */

export default function DiffPage() {
  const s = getPrimarySession();
  const files = getChangedFiles(s.id);

  // Active file: prefer one whose hunks carry a mix of confidences (so the
  // attribution UI has the banner + covered/uncovered to show); else first file.
  const active = files.find((f) => f.path === "app/globals.css") ?? files[0];

  const hunks: DiffHunk[] = active ? getHunks(active.id) : [];

  // per-hunk attribution (first attribution row drives the hunk's confidence).
  const hunkAttr = new Map<string, Attribution | undefined>();
  for (const h of hunks) {
    hunkAttr.set(h.id, getAttributionsForHunk(h.id)[0]);
  }

  const linkedEvents = active ? getLinkedEventsForFile(active.id) : [];
  // selected linked event -> fills the Event Details panel.
  const selected = linkedEvents[0];
  const selectedEvent = selected ? getEvent(selected.event.id) : undefined;

  const annotations: Annotation[] = getAnnotations(s.id);

  // coverage: how many hunks map to a real (non-null) event.
  const coveredCount = hunks.filter((h) => {
    const a = hunkAttr.get(h.id);
    return a != null && a.eventId != null;
  }).length;
  // banner shows when any hunk is medium / unattributed.
  const showBanner = hunks.some((h) => {
    const a = hunkAttr.get(h.id);
    return a == null || a.confidence !== "high";
  });

  const tree = buildTree(files);

  // minimap: spread event-seq annotations across the run width.
  const lastSeq = Math.max(s.turnCount, ...annotations.map((a) => a.atSeq), 1);
  const TICKS = 64;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const seqAt = ((i + 0.5) / TICKS) * lastSeq;
    let kindClass = "";
    let best = Infinity;
    for (const a of annotations) {
      const d = Math.abs(a.atSeq - seqAt);
      if (d < best && d <= lastSeq / TICKS) {
        best = d;
        kindClass = annotationKindClass(a.kind);
      }
    }
    return kindClass;
  });
  // playhead at the selected event's position along the run.
  const playSeq = selectedEvent ? selectedEvent.seq : lastSeq * 0.5;
  const playPct = Math.min(98, Math.max(2, (playSeq / lastSeq) * 100));

  const runnerClass = s.runner; // 'claude-code' | 'codex' | 'cursor'
  const runnerLabel =
    s.runner === "claude-code"
      ? "Claude Code"
      : s.runner === "codex"
      ? "Codex"
      : "Cursor";

  const halfTokens = Math.round(s.tokenUsage / 2);

  return (
    <>
      {/* metrics band */}
      <div className="metrics">
        <div className="metric">
          <span className="label">Branch</span>
          <span className="value">
            <span className="metric-branch">⎇ main</span>
          </span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Commit range</span>
          <span className="value mono">
            <span className="metric-commit">a13c9f2..b8e71d4</span>
            <span className="icon-btn" aria-label="copy">
              ⧉
            </span>
          </span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Model</span>
          <span className="value">
            <span className="runner-pill">
              <span className={`runner-dot ${runnerClass}`} />
              {runnerLabel}
            </span>
          </span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Duration</span>
          <span className="value">{fmtDuration(s.durationMs)}</span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Turns</span>
          <span className="value">{fmtInt(s.turnCount)}</span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Tokens</span>
          <span className="value">{fmtInt(s.tokenUsage)}</span>
          <span className="sub">
            ({fmtInt(halfTokens)} in / {fmtInt(halfTokens)} out)
          </span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Cost</span>
          <span className="value">
            {s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="metric-sep" />
        <div className="metric">
          <span className="label">Result</span>
          <span className="value">
            <span
              className={`badge ${
                s.status === "done"
                  ? "done"
                  : s.status === "running"
                  ? "running"
                  : "failed"
              }`}
            >
              {s.status === "done"
                ? "Done ✓"
                : s.status === "running"
                ? "Running"
                : "Failed"}
            </span>
          </span>
        </div>
      </div>

      {/* tab strip — active = Git */}
      <div className="tabs">
        <span className="tab">Transcript</span>
        <span className="tab">Tools</span>
        <span className="tab active">Git</span>
        <span className="tab">Subagents</span>
        <span className="tab">Raw JSON</span>
        <span className="tabs-spacer" />
        <span className="tabs-tool">
          <span className="icon-btn" aria-label="more">
            ⋯
          </span>
        </span>
      </div>

      {/* 3-col diff working area */}
      <div
        className="layout3 diffview"
        style={{ gridTemplateColumns: "280px minmax(0,1fr) 340px" }}
      >
        {/* COLUMN 1 — changed-files tree */}
        <div className="sidebar">
          <div className="filetree-head">
            <div className="title">Changed Files</div>
            <div className="sub">{files.length} files changed</div>
          </div>
          <div className="filetree">
            {tree.map((row, i) => {
              if (row.kind === "folder") {
                return (
                  <div
                    key={`folder-${i}`}
                    className={`file-row is-folder ${indentClass(row.depth)}`}
                  >
                    <span className="twisty">▾</span>
                    <span className="ficon">▸</span>
                    <span className="fname">{row.name}</span>
                    <span className="counts">
                      <span className="add">+{row.additions}</span>
                      <span className="del">-{row.deletions}</span>
                    </span>
                  </div>
                );
              }
              const f = row.file;
              const isActive = !!active && f.id === active.id;
              return (
                <div
                  key={f.id}
                  className={`file-row ${indentClass(row.depth)}${
                    isActive ? " active" : ""
                  }`}
                >
                  <span className="twisty" />
                  <span className="ficon" title={f.status}>
                    {statusGlyph(f.status)}
                  </span>
                  <span className="fname">{basename(f.path)}</span>
                  <span className="counts">
                    <span className="add">+{f.additions}</span>
                    <span className="del">-{f.deletions}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* COLUMN 2 — diff for the active file */}
        <div className="main">
          <div className="diff-wrap">
            <div className="diff-toolbar">
              <span className="fpath">{active ? active.path : "—"}</span>
              <span className="fstats">
                <span className="add">{active ? active.additions : 0} additions</span>
                {" / "}
                <span className="del">{active ? active.deletions : 0} deletions</span>
              </span>
              <span className="spacer" />
              <span className="segmented">
                <button className="active">Unified</button>
                <button>Split</button>
              </span>
            </div>

            <div className="hunk-nav">
              <span className="nav-btn" aria-label="prev hunk">
                ‹
              </span>
              <span className="nav-btn" aria-label="next hunk">
                ›
              </span>
              <span className="pos">1 of {hunks.length}</span>
              <span style={{ flex: "1 1 auto" }} />
              <span>Hunk 1 of {hunks.length}</span>
            </div>

            <div className="diff">
              {hunks.map((h) => {
                const attr = hunkAttr.get(h.id);
                const conf: Confidence = attr ? attr.confidence : "unattributed";
                const method: AttributionMethod = attr ? attr.method : "dirty_worktree";
                const linked = attr != null && attr.eventId != null;
                // running line numbers parsed from the @@ header (best-effort).
                const m = h.header.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
                let oldNo = m ? parseInt(m[1], 10) : 1;
                let newNo = m ? parseInt(m[2], 10) : 1;
                const lines = h.content.split("\n");

                return (
                  <div className="diff-hunk" key={h.id}>
                    <div className="diff-header">
                      <span className="htext">{h.header}</span>
                      <span className="le-right">
                        <span className={`confidence ${conf}`}>
                          {methodLabel(method)}
                        </span>
                        <span style={{ color: "var(--muted-2)" }}>⋯</span>
                      </span>
                    </div>
                    {lines.map((line, li) => {
                      const cls = lineClass(line);
                      const text = line.length ? line.slice(1) : "";
                      const oldCell = cls === "add" ? "" : String(oldNo);
                      const newCell = cls === "del" ? "" : String(newNo);
                      if (cls !== "add") oldNo += 1;
                      if (cls !== "del") newNo += 1;
                      const marker = cls === "add" ? "+" : cls === "del" ? "-" : " ";
                      const showNode = linked && li === 0;
                      return (
                        <div
                          className={`diff-line${cls ? " " + cls : ""}${
                            linked ? " linked" : ""
                          }`}
                          key={`${h.id}-${li}`}
                        >
                          <span className="lno">{oldCell}</span>
                          <span className="lno diff-gutter">
                            {newCell}
                            {showNode && <span className="diff-attr-node" />}
                          </span>
                          <span className="marker">{marker}</span>
                          <span className="ltext">{text}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {hunks.length === 0 && (
                <div className="empty" style={{ padding: 16 }}>
                  No hunks.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* COLUMN 3 — attribution aside */}
        <div className="aside">
          {showBanner && (
            <div className="attr-banner">
              <span className="bi">⚠</span>
              <span>
                Some changes were made after shell commands; attribution is
                probabilistic.
              </span>
            </div>
          )}

          <div className="linked-events">
            <div className="panel-title">
              Linked Events <span className="count">({linkedEvents.length})</span>
            </div>
            {linkedEvents.map((le, i) => {
              const isActive =
                !!selected && le.event.id === selected.event.id && i === 0;
              return (
                <div
                  key={`${le.event.id}-${le.hunkId}`}
                  className={`linked-event${isActive ? " active" : ""}`}
                >
                  <span className="le-idx">{i + 1}</span>
                  <span className="le-body">
                    <span className="le-turn">
                      <b>Turn {le.event.seq}:</b> {le.event.title}
                    </span>
                  </span>
                  <span className="le-right">
                    <span className={`confidence ${le.confidence}`}>
                      {methodLabel(le.method)}
                    </span>
                    <span className="le-pct">{confidencePct(le.confidence)}</span>
                  </span>
                </div>
              );
            })}
            {linkedEvents.length === 0 && (
              <div className="empty">No linked events.</div>
            )}
          </div>

          {/* Event Details for the selected linked event */}
          {selected && selectedEvent && (
            <>
              <div
                className="panel-title"
                style={{ padding: "0 14px", margin: "4px 0 0" }}
              >
                Event Details
              </div>
              <dl className="kv">
                <dt>Time</dt>
                <dd className="v mono">{selectedEvent.ts}</dd>
                <dt>Tool</dt>
                <dd className="v mono">{toolName(selectedEvent, selected.method)}</dd>
                <dt>Path</dt>
                <dd className="v mono">
                  {selectedEvent.filePath ?? active?.path ?? "—"}
                </dd>
                <dt>Exit code</dt>
                <dd className="v mono">
                  {selectedEvent.exitCode != null ? selectedEvent.exitCode : "0"}
                </dd>
                <dt>Latency</dt>
                <dd className="v mono">{fmtLatency(selectedEvent.durationMs)}</dd>
              </dl>
              <div
                className="diff-toolbar"
                style={{ borderBottom: "none", paddingTop: 4 }}
              >
                <span className="fstats">
                  <span className="add">+{active ? active.additions : 0}</span>
                  {" / "}
                  <span className="del">-{active ? active.deletions : 0}</span>
                </span>
                <span className="spacer" />
                <span className="btn btn-sm">{"{}"} Raw JSON</span>
              </div>
            </>
          )}

          {/* attr-timeline: which events touched this file over time */}
          <div className="attr-timeline">
            <div className="attr-timeline-head">
              <span className="title">{active ? basename(active.path) : "—"}</span>
              <span className="count">{linkedEvents.length} events</span>
            </div>
            <div className="attr-track">
              {linkedEvents.map((le, i) => (
                <span
                  key={`node-${le.event.id}-${i}`}
                  className={`attr-node ${eventKindClass(le.event.type)}`}
                  title={le.event.title}
                >
                  {le.event.seq}
                </span>
              ))}
              {/* unattributed hunks carry no event — surface them as gray nodes */}
              {hunks
                .filter((h) => {
                  const a = hunkAttr.get(h.id);
                  return a == null || a.eventId == null;
                })
                .map((h, i) => (
                  <span
                    key={`uncertain-${h.id}-${i}`}
                    className="attr-node uncertain"
                    title="Unattributed hunk (no event)"
                  >
                    ?
                  </span>
                ))}
            </div>
          </div>

          {/* hunk coverage */}
          <div className="hunk-coverage">
            <div className="hunk-coverage-head">
              <span>Hunk coverage</span>
              <span className="frac">
                {coveredCount} / {hunks.length} hunks
              </span>
            </div>
            <div className="hunk-segs">
              {hunks.map((h, i) => {
                const a = hunkAttr.get(h.id);
                const conf: Confidence = a ? a.confidence : "unattributed";
                const covered = a != null && a.eventId != null;
                let cls = "uncovered";
                if (conf === "medium") cls = "medium";
                else if (covered) cls = "covered";
                const isCurrent = i === 0 && covered;
                return (
                  <span
                    key={`seg-${h.id}`}
                    className={`hunk-seg ${cls}${isCurrent ? " active" : ""}`}
                    title={`Hunk ${i + 1}: ${conf}`}
                  />
                );
              })}
            </div>
          </div>

          {/* attribution notes (annotations) */}
          {annotations.length > 0 && (
            <div className="annotations">
              <div className="ahead">
                Attribution notes{" "}
                <span className="count">({annotations.length})</span>
              </div>
              {annotations.map((a) => (
                <div className="annotation" key={a.id}>
                  <span className={`akind ${a.kind}`} />
                  <span className="nowrap">{a.note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* bottom: session change minimap */}
      <div className="minimap">
        <div className="minimap-head">
          <span className="mtitle">Session change minimap</span>
          <span className="spacer" />
          <span className="minimap-legend">
            <span className="legend-item">
              <span className="legend-swatch edit" />
              edit
            </span>
            <span className="legend-item">
              <span className="legend-swatch command" />
              command
            </span>
            <span className="legend-item">
              <span className="legend-swatch commit" />
              commit
            </span>
            <span className="legend-item">
              <span className="legend-swatch test" />
              test
            </span>
            <span className="legend-item">
              <span className="legend-swatch uncertain" />
              uncertain
            </span>
          </span>
          <span className="icon-btn" aria-label="more">
            ⋯
          </span>
        </div>
        <div className="minimap-track">
          {ticks.map((cls, i) => (
            <span
              key={`tick-${i}`}
              className={`minimap-tick${cls ? " " + cls : ""}`}
              style={{ height: `${30 + ((i * 37) % 60)}%` }}
            />
          ))}
          <span className="minimap-playhead" style={{ left: `${playPct}%` }} />
        </div>
        <div className="minimap-axis">
          <span className="tick">0:00</span>
          <span className="tick">{selectedEvent ? selectedEvent.ts : ""}</span>
          <span className="tick">{fmtDuration(s.durationMs)}</span>
        </div>
      </div>
    </>
  );
}
