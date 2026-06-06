"use client";

// components/DiffViewer.tsx — Screen B: Git diff + attribution viewer (client).
//
// Interactive client component. The route (app/diff/page.tsx) is a thin server
// wrapper that loads a SessionBundle and renders this. Every control here has a
// real handler: file selection, folder collapse, Unified/Split toggle, hunk
// navigation, linked-event selection, Raw JSON toggle, copy buttons, and
// session switching (the only navigation — via router.push("/diff?session=")).
// Nothing is fabricated: tokens, branch, commit count, tools, confidences and
// the minimap are all derived from real bundle data.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TimeRibbon from "@/components/TimeRibbon";
import type {
  Session,
  SessionBundle,
  ChangedFile,
  DiffHunk,
  Attribution,
  Confidence,
  AttributionMethod,
  FileStatus,
  Annotation,
  AnnotationKind,
  LinkedEvent,
  TranscriptEvent,
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

// Confidence -> the real label shown on the linked-event row (no fake percent).
function confidenceLabel(c: Confidence): string {
  switch (c) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "unattributed":
      return "unattributed";
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

// EventType -> minimap tick "kind" class (legend buckets shared with screen A).
function minimapKind(type: string): string {
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
    case "error":
      return "uncertain";
    default:
      return "edit";
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

// "12.1M" / "12.4K" compaction for the header stat cluster.
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// "12.4K" style compaction for big token counts in the metric .sub line.
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
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

type TreeFile = {
  kind: "file";
  file: ChangedFile;
  depth: number;
  dir: string;
};
type TreeFolder = {
  kind: "folder";
  name: string;
  // full path prefix of this folder (used as the collapse key)
  path: string;
  depth: number;
  additions: number;
  deletions: number;
};
type TreeRow = TreeFile | TreeFolder;

// Build a properly-nested, depth-tagged render list of folder + file rows.
// Real ingested paths are absolute (/Users/.../LLMWiki/wiki/concepts/x.md), so:
//  1. strip the directory prefix shared by ALL files (no deep Users/cherie/… chain),
//  2. nest folders so each folder appears exactly ONCE (not repeated per group),
//  3. aggregate +/- onto each folder from all its descendants.
// folder.path / file.dir are the (stripped) directory keys used for collapse.
function buildTree(files: ChangedFile[]): TreeRow[] {
  if (files.length === 0) return [];

  const dirSegs = (p: string) => p.split("/").filter(Boolean).slice(0, -1);

  // longest directory prefix common to every file (segment-wise)
  let common = dirSegs(files[0].path);
  for (const f of files.slice(1)) {
    const d = dirSegs(f.path);
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const strippedDir = (f: ChangedFile) => dirSegs(f.path).slice(common.length);

  type Node = {
    name: string;
    path: string;
    folders: Map<string, Node>;
    files: ChangedFile[];
    add: number;
    del: number;
  };
  const root: Node = { name: "", path: "", folders: new Map(), files: [], add: 0, del: 0 };

  for (const f of files) {
    let node = root;
    let prefix = "";
    for (const seg of strippedDir(f)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = node.folders.get(seg);
      if (!child) {
        child = { name: seg, path: prefix, folders: new Map(), files: [], add: 0, del: 0 };
        node.folders.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }

  // aggregate +/- up the tree
  function agg(n: Node): { add: number; del: number } {
    let add = n.files.reduce((a, f) => a + f.additions, 0);
    let del = n.files.reduce((a, f) => a + f.deletions, 0);
    for (const c of n.folders.values()) {
      const r = agg(c);
      add += r.add;
      del += r.del;
    }
    n.add = add;
    n.del = del;
    return { add, del };
  }
  agg(root);

  // flatten depth-first: folders (sorted) first, then files (sorted)
  const rows: TreeRow[] = [];
  function walk(n: Node, depth: number) {
    for (const c of [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: "folder", name: c.name, path: c.path, depth, additions: c.add, deletions: c.del });
      walk(c, depth + 1);
    }
    for (const f of [...n.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", file: f, depth, dir: strippedDir(f).join("/") });
    }
  }
  walk(root, 0);
  return rows;
}

// Parse the running old/new starting line numbers from a @@ hunk header.
function hunkStart(header: string): { oldNo: number; newNo: number } {
  const m = header.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
  return {
    oldNo: m ? parseInt(m[1], 10) : 1,
    newNo: m ? parseInt(m[2], 10) : 1,
  };
}

/* ---- minimap (deterministic from event stream) --------------------------- */

type MiniBucket = { count: number; kind: string; seqMid: number };

// Bucket the run's events into TICKS bins along their seq, sizing each bar by
// the bin's event count and coloring it by the most "interesting" event kind in
// the bin (errors/commits win over edits). Deterministic — no random heights.
function buildMinimap(
  events: TranscriptEvent[],
  annotations: Annotation[],
  ticks: number
): { buckets: MiniBucket[]; lastSeq: number } {
  const lastSeq = Math.max(
    1,
    ...events.map((e) => e.seq),
    ...annotations.map((a) => a.atSeq)
  );
  const buckets: MiniBucket[] = Array.from({ length: ticks }, (_, i) => ({
    count: 0,
    kind: "",
    seqMid: ((i + 0.5) / ticks) * lastSeq,
  }));
  // priority for choosing a bucket's dominant color
  const rank: Record<string, number> = {
    uncertain: 4,
    commit: 3,
    test: 2,
    command: 1,
    edit: 0,
  };
  const place = (seq: number, kind: string) => {
    const idx = Math.min(ticks - 1, Math.floor((seq / lastSeq) * ticks));
    const b = buckets[idx];
    b.count += 1;
    if (!b.kind || (rank[kind] ?? 0) > (rank[b.kind] ?? 0)) b.kind = kind;
  };
  for (const e of events) place(e.seq, minimapKind(e.type));
  // annotations (errors/commits) bump their bucket's color even if sparse
  for (const a of annotations) place(a.atSeq, annotationKindClass(a.kind));
  return { buckets, lastSeq };
}

/* ---- props ---------------------------------------------------------------- */

interface Props {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
}

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export default function DiffViewer({ sessions, bundle, currentId }: Props) {
  const router = useRouter();
  const s = bundle.session;
  const files = bundle.changedFiles;

  /* ---- state -------------------------------------------------------------- */

  // Active file: prefer one whose hunks carry a mix of confidences; else first.
  const initialFileId = useMemo(() => {
    const mixed = files.find((f) => f.path.endsWith("globals.css"));
    return (mixed ?? files[0])?.id ?? "";
  }, [files]);

  const [activeFileId, setActiveFileId] = useState<string>(initialFileId);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [hunkIndex, setHunkIndex] = useState<number>(0);
  const [selectedLinkedEventId, setSelectedLinkedEventId] =
    useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [copied, setCopied] = useState<string | null>(null);

  // When the session (props) changes, reset per-session UI state.
  useEffect(() => {
    setActiveFileId(initialFileId);
    setHunkIndex(0);
    setSelectedLinkedEventId(null);
    setShowRawJson(false);
    setCollapsedFolders(new Set());
  }, [currentId, initialFileId]);

  /* ---- derived: active file + its hunks / attributions / events ---------- */

  const active: ChangedFile | undefined = useMemo(
    () => files.find((f) => f.id === activeFileId) ?? files[0],
    [files, activeFileId]
  );

  const hunks: DiffHunk[] = active ? bundle.hunks[active.id] ?? [] : [];

  // per-hunk attribution (first attribution row drives the hunk's confidence).
  const hunkAttr = useMemo(() => {
    const m = new Map<string, Attribution | undefined>();
    for (const h of hunks) m.set(h.id, (bundle.attributions[h.id] ?? [])[0]);
    return m;
  }, [hunks, bundle.attributions]);

  const linkedEvents: LinkedEvent[] = active
    ? bundle.linkedEvents[active.id] ?? []
    : [];

  // Selected linked event -> Event Details panel. Default to the first row.
  const selected: LinkedEvent | undefined = useMemo(() => {
    if (selectedLinkedEventId) {
      const hit = linkedEvents.find(
        (le) => le.event.id === selectedLinkedEventId
      );
      if (hit) return hit;
    }
    return linkedEvents[0];
  }, [linkedEvents, selectedLinkedEventId]);

  const selectedEvent: TranscriptEvent | undefined = selected?.event;

  const annotations: Annotation[] = bundle.annotations;

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

  const tree = useMemo(() => buildTree(files), [files]);

  // Hide rows whose ancestor folder is collapsed.
  const visibleTree = useMemo(() => {
    return tree.filter((row) => {
      const ownerDir = row.kind === "folder" ? row.path : row.dir;
      for (const c of collapsedFolders) {
        // a row is hidden if its dir is the collapsed folder or nested below it
        if (ownerDir === c || ownerDir.startsWith(c + "/")) {
          // the collapsed folder header itself stays visible
          if (row.kind === "folder" && row.path === c) continue;
          return false;
        }
      }
      return true;
    });
  }, [tree, collapsedFolders]);

  /* ---- minimap ------------------------------------------------------------ */

  const TICKS = 64;
  const { buckets, lastSeq } = useMemo(
    () => buildMinimap(bundle.events, annotations, TICKS),
    [bundle.events, annotations]
  );
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  // playhead at the selected event's position along the run.
  const playSeq = selectedEvent ? selectedEvent.seq : lastSeq * 0.5;
  const playPct = Math.min(98, Math.max(2, (playSeq / lastSeq) * 100));

  /* ---- metrics band derived values --------------------------------------- */

  const runnerClass = s.runner;
  const runnerLabel = RUNNER_LABEL[s.runner] ?? s.runner;
  const branch = s.gitBranch ?? "main";
  const commitText = `${s.commitCount} commit${s.commitCount === 1 ? "" : "s"}`;

  /* ---- refs for hunk scroll-into-view ------------------------------------ */

  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Clamp hunkIndex whenever the active file's hunk count changes.
  useEffect(() => {
    setHunkIndex((i) => Math.min(Math.max(0, i), Math.max(0, hunks.length - 1)));
  }, [hunks.length]);

  function gotoHunk(next: number) {
    if (hunks.length === 0) return;
    const clamped = Math.min(Math.max(0, next), hunks.length - 1);
    setHunkIndex(clamped);
    const el = hunkRefs.current[clamped];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---- handlers ----------------------------------------------------------- */

  function selectFile(id: string) {
    setActiveFileId(id);
    setHunkIndex(0);
    setSelectedLinkedEventId(null);
    setShowRawJson(false);
  }

  function toggleFolder(path: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function switchSession(id: string) {
    if (id === currentId) return;
    router.push(`/diff?session=${id}`);
  }

  async function copyValue(value: string, key: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopied(key);
        setTimeout(() => setCopied((k) => (k === key ? null : k)), 1200);
      }
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  // Raw JSON for the selected linked event (real serialization).
  const rawJson = selectedEvent
    ? JSON.stringify(
        {
          id: selectedEvent.id,
          seq: selectedEvent.seq,
          ts: selectedEvent.ts,
          type: selectedEvent.type,
          actor: selectedEvent.actor,
          title: selectedEvent.title,
          filePath: selectedEvent.filePath,
          command: selectedEvent.command,
          exitCode: selectedEvent.exitCode,
          durationMs: selectedEvent.durationMs,
          tokenUsage: selectedEvent.tokenUsage,
          confidence: selected!.confidence,
          method: selected!.method,
          tool: toolName(selectedEvent, selected!.method),
        },
        null,
        2
      )
    : "";

  return (
    <>
      {/* metrics band */}
      <div className="sessbar">
        <div className="sessbar-id">
          <span className={`runner-dot ${runnerClass}`} aria-hidden />
          <span className="sessbar-title" title={s.title}>
            {s.title}
          </span>
          <span className={`badge ${s.status}`}>{s.status}</span>
          <span className="sessbar-meta">
            Git diff · {runnerLabel} · <span className="mono">⎇ {branch}</span> · {commitText} ·{" "}
            {s.startedAt.replace("T", " ").slice(0, 16)}
          </span>
        </div>
        <div className="sessbar-stats">
          <div className="kstat">
            <b>{fmtInt(files.length)}</b>
            <span>files</span>
          </div>
          <div className="kstat">
            <b>{fmtDuration(s.durationMs)}</b>
            <span>duration</span>
          </div>
          <div className="kstat">
            <b>{fmtInt(s.turnCount)}</b>
            <span>turns</span>
          </div>
          <div
            className="kstat"
            title={`${fmtInt(s.tokenIn)} in · ${fmtInt(s.tokenOut)} out`}
          >
            <b>{fmtCompact(s.tokenIn + s.tokenOut)}</b>
            <span>tokens</span>
          </div>
        </div>
      </div>

      {/* tab strip — active = Git. Session picker lives at the right so session
          switching stays reachable from this screen (the only navigation). */}
      <div className="tabs">
        {(
          [
            ["transcript", "Transcript"],
            ["tools", "Tools"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="tab active">Git</span>
        {(
          [
            ["skills", "Skills"],
            ["subagents", "Subagents"],
            ["raw", "Raw JSON"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="tabs-spacer" />
        <span className="tabs-tool">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span className="muted small">Session</span>
            <select
              value={currentId}
              onChange={(e) => switchSession(e.target.value)}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 9px",
                color: "var(--text)",
                font: "inherit",
                fontSize: 12.5,
                cursor: "pointer",
                maxWidth: 260,
              }}
            >
              {sessions.map((sess) => (
                <option key={sess.id} value={sess.id}>
                  {sess.title}
                </option>
              ))}
            </select>
          </label>
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
            {visibleTree.map((row, i) => {
              if (row.kind === "folder") {
                const collapsed = collapsedFolders.has(row.path);
                return (
                  <div
                    key={`folder-${row.path}-${i}`}
                    className={`file-row is-folder ${indentClass(row.depth)}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleFolder(row.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleFolder(row.path);
                      }
                    }}
                  >
                    <span className="twisty">{collapsed ? "▸" : "▾"}</span>
                    <span className="ficon">{collapsed ? "▸" : "▸"}</span>
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
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFile(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectFile(f.id);
                    }
                  }}
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
            {files.length === 0 && (
              <div className="empty" style={{ padding: 12 }}>
                No changed files in this session.
              </div>
            )}
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
                <button
                  type="button"
                  className={viewMode === "unified" ? "active" : ""}
                  onClick={() => setViewMode("unified")}
                >
                  Unified
                </button>
                <button
                  type="button"
                  className={viewMode === "split" ? "active" : ""}
                  onClick={() => setViewMode("split")}
                >
                  Split
                </button>
              </span>
            </div>

            <div className="hunk-nav">
              <button
                type="button"
                className="nav-btn"
                aria-label="prev hunk"
                onClick={() => gotoHunk(hunkIndex - 1)}
                disabled={hunks.length === 0 || hunkIndex === 0}
              >
                ‹
              </button>
              <button
                type="button"
                className="nav-btn"
                aria-label="next hunk"
                onClick={() => gotoHunk(hunkIndex + 1)}
                disabled={hunks.length === 0 || hunkIndex >= hunks.length - 1}
              >
                ›
              </button>
              <span className="pos">
                {hunks.length === 0 ? 0 : hunkIndex + 1} of {hunks.length}
              </span>
              <span style={{ flex: "1 1 auto" }} />
              <span>
                Hunk {hunks.length === 0 ? 0 : hunkIndex + 1} of {hunks.length}
              </span>
            </div>

            <div className="diff">
              {hunks.map((h, hi) => {
                const attr = hunkAttr.get(h.id);
                const conf: Confidence = attr ? attr.confidence : "unattributed";
                const method: AttributionMethod = attr
                  ? attr.method
                  : "dirty_worktree";
                const linked = attr != null && attr.eventId != null;
                const { oldNo: oldStart, newNo: newStart } = hunkStart(h.header);
                const lines = h.content.split("\n");
                const isCurrent = hi === hunkIndex;

                return (
                  <div
                    className={`diff-hunk${isCurrent ? " active" : ""}`}
                    key={h.id}
                    ref={(el) => {
                      hunkRefs.current[hi] = el;
                    }}
                    style={
                      isCurrent
                        ? { boxShadow: "inset 0 0 0 2px var(--accent-ring)" }
                        : undefined
                    }
                  >
                    <div className="diff-header">
                      <span className="htext">{h.header}</span>
                      <span className="le-right">
                        <span className={`confidence ${conf}`}>
                          {methodLabel(method)}
                        </span>
                        <span style={{ color: "var(--muted-2)" }}>⋯</span>
                      </span>
                    </div>

                    {viewMode === "unified" ? (
                      // ---- UNIFIED: single column ----
                      (() => {
                        let oldNo = oldStart;
                        let newNo = newStart;
                        return lines.map((line, li) => {
                          const cls = lineClass(line);
                          const text = line.length ? line.slice(1) : "";
                          const oldCell = cls === "add" ? "" : String(oldNo);
                          const newCell = cls === "del" ? "" : String(newNo);
                          if (cls !== "add") oldNo += 1;
                          if (cls !== "del") newNo += 1;
                          const marker =
                            cls === "add" ? "+" : cls === "del" ? "-" : " ";
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
                        });
                      })()
                    ) : (
                      // ---- SPLIT: old | new two columns ----
                      (() => {
                        // Build aligned old/new rows. Deletions sit on the left,
                        // additions on the right; context lines align on both.
                        type Side = { no: number | null; text: string; cls: "" | "del" } ;
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
                            // context: flush any pending unbalanced rows, then add
                            while (leftRows.length < rightRows.length)
                              leftRows.push({ no: null, text: "", cls: "" });
                            while (rightRows.length < leftRows.length)
                              rightRows.push({ no: null, text: "", cls: "" });
                            leftRows.push({ no: oldNo, text, cls: "" });
                            rightRows.push({ no: newNo, text, cls: "" });
                            oldNo += 1;
                            newNo += 1;
                          }
                        }
                        while (leftRows.length < rightRows.length)
                          leftRows.push({ no: null, text: "", cls: "" });
                        while (rightRows.length < leftRows.length)
                          rightRows.push({ no: null, text: "", cls: "" });
                        const rowCount = leftRows.length;
                        return (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                            }}
                          >
                            <div style={{ borderRight: "1px solid var(--border)" }}>
                              {Array.from({ length: rowCount }, (_, ri) => {
                                const L = leftRows[ri];
                                return (
                                  <div
                                    className={`diff-line${
                                      L.cls ? " " + L.cls : ""
                                    }`}
                                    key={`L-${h.id}-${ri}`}
                                    style={{
                                      gridTemplateColumns: "44px 16px 1fr",
                                    }}
                                  >
                                    <span className="lno">
                                      {L.no != null ? L.no : ""}
                                    </span>
                                    <span className="marker">
                                      {L.cls === "del" ? "-" : " "}
                                    </span>
                                    <span className="ltext">{L.text}</span>
                                  </div>
                                );
                              })}
                            </div>
                            <div>
                              {Array.from({ length: rowCount }, (_, ri) => {
                                const R = rightRows[ri];
                                const showNode = linked && ri === 0;
                                return (
                                  <div
                                    className={`diff-line${
                                      R.cls ? " " + R.cls : ""
                                    }${linked ? " linked" : ""}`}
                                    key={`R-${h.id}-${ri}`}
                                    style={{
                                      gridTemplateColumns: "44px 16px 1fr",
                                    }}
                                  >
                                    <span className="lno diff-gutter">
                                      {R.no != null ? R.no : ""}
                                      {showNode && (
                                        <span className="diff-attr-node" />
                                      )}
                                    </span>
                                    <span className="marker">
                                      {R.cls === "add" ? "+" : " "}
                                    </span>
                                    <span className="ltext">{R.text}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()
                    )}
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
                !!selected && le.event.id === selected.event.id;
              return (
                <div
                  key={`${le.event.id}-${le.hunkId}-${i}`}
                  className={`linked-event${isActive ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelectedLinkedEventId(le.event.id);
                    setShowRawJson(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedLinkedEventId(le.event.id);
                      setShowRawJson(false);
                    }
                  }}
                >
                  <span className="le-idx">{i + 1}</span>
                  <div className="le-body">
                    <div className="le-turn">
                      <b>Turn {le.event.seq}:</b> {le.event.title}
                    </div>
                    <div className="le-meta">
                      <span className={`confidence ${le.confidence}`}>
                        {methodLabel(le.method)}
                      </span>
                      <span className="le-conf">{confidenceLabel(le.confidence)}</span>
                    </div>
                  </div>
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
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowRawJson((v) => !v)}
                >
                  {"{}"} Raw JSON
                </button>
              </div>
              {showRawJson && (
                <pre
                  className="run-json"
                  style={{ margin: "0 14px 10px", whiteSpace: "pre-wrap" }}
                >
                  {rawJson}
                </pre>
              )}
            </>
          )}

          {/* attr-timeline: which events touched this file over time */}
          <div className="attr-timeline">
            <div className="attr-timeline-head">
              <span className="title">{active ? basename(active.path) : "—"}</span>
              <span className="count">{linkedEvents.length} events</span>
            </div>
            <div className="attr-track">
              {linkedEvents.map((le, i) => {
                const isSel = !!selected && le.event.id === selected.event.id;
                return (
                  <span
                    key={`node-${le.event.id}-${i}`}
                    className={`attr-node ${eventKindClass(le.event.type)}`}
                    title={le.event.title}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedLinkedEventId(le.event.id);
                      setShowRawJson(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedLinkedEventId(le.event.id);
                        setShowRawJson(false);
                      }
                    }}
                    style={{
                      cursor: "pointer",
                      outline: isSel ? "2px solid var(--accent)" : undefined,
                      outlineOffset: 1,
                    }}
                  >
                    {le.event.seq}
                  </span>
                );
              })}
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
                const isCurrent = i === hunkIndex;
                return (
                  <span
                    key={`seg-${h.id}`}
                    className={`hunk-seg ${cls}${isCurrent ? " active" : ""}`}
                    title={`Hunk ${i + 1}: ${conf}`}
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => gotoHunk(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        gotoHunk(i);
                      }
                    }}
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
                  <span className="nowrap">{a.note ?? a.kind}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* bottom: real time ribbon — each segment's width is the wall-clock time
          until the next step, so long operations/waits are visibly wide. */}
      <TimeRibbon
        events={bundle.events}
        selectedId={selectedEvent?.id}
        title="Time spent (session)"
      />
    </>
  );
}
