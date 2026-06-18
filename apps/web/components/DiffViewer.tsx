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
import { basename, fmtCompact, fmtDuration, fmtInt, fmtLatency, fmtTok } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
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

// A small filled folder mark so directory rows read as folders at a glance
// (files carry a colored A/M/D status chip instead).
function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path
        d="M1.6 4.3c0-.62.5-1.12 1.12-1.12h2.9c.3 0 .58.12.79.33l.84.84h6.04c.62 0 1.12.5 1.12 1.12v6.1c0 .62-.5 1.12-1.12 1.12H2.72c-.62 0-1.12-.5-1.12-1.12V4.3z"
        fill="currentColor"
      />
    </svg>
  );
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

// A diff line's class from its leading character.
function lineClass(line: string): "" | "add" | "del" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function indentClass(depth: number): string {
  if (depth <= 0) return "";
  if (depth === 1) return "indent-1";
  if (depth === 2) return "indent-2";
  if (depth === 3) return "indent-3";
  if (depth === 4) return "indent-4";
  return "indent-5";
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
// Real ingested paths are absolute (/Users/<you>/<repo>/wiki/concepts/x.md), so:
//  1. strip the directory prefix shared by ALL files (no deep /Users/<you>/… chain),
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
      // Compact single-child folder chains into ONE row (VS Code "compact
      // folders"): projects > university-course > lectures > work  becomes a
      // single "projects/university-course/lectures/work" row — so a file nested
      // 8 levels deep no longer emits 8 directory rows (which made 1 file look
      // like a dozen changes). Stop merging at a fork (>1 subfolder) or a folder
      // that holds files of its own.
      let node = c;
      let label = c.name;
      while (node.folders.size === 1 && node.files.length === 0) {
        const only = [...node.folders.values()][0];
        label = `${label}/${only.name}`;
        node = only;
      }
      rows.push({
        kind: "folder",
        name: label,
        path: node.path,
        depth,
        additions: node.add,
        deletions: node.del,
      });
      walk(node, depth + 1);
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

/* ---- props ---------------------------------------------------------------- */

interface Props {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
  // When embedded inside the SessionViewer "Git" tab, render ONLY the
  // [file-tree | diff | attribution] working area — the surrounding chrome
  // (session bar, tab strip + session picker, time ribbon) belongs to the host
  // shell, and the session list stays in the host's sidebar. Standalone /diff
  // (embedded=false) still renders the full page.
  embedded?: boolean;
  // Bidirectional transcript↔diff link:
  //  • focusEventId — when the user jumps in from the transcript ("see this
  //    edit's diff"), open the file + hunk that this event produced.
  //  • focusFileId — when the user jumps from a turn rollup's files chip,
  //    open that changed file without inventing a separate link model.
  //  • focusHunkId — when a finding's logical evidence resolves to a hunk,
  //    open the containing file and mark that hunk active.
  //  • onJumpToEvent — jump back out ("which step produced this diff"): the host
  //    switches to the Transcript tab and selects the given event.
  focusEventId?: string;
  focusFileId?: string;
  focusHunkId?: string;
  onJumpToEvent?: (eventId: string) => void;
}

// Big diffs are paginated so a 280-edit session no longer mounts thousands of
// <div> rows at once (which froze the Git tab). We render the active file's
// hunks one page at a time and cap the line count of any single very long hunk;
// hunk navigation and the "show more" controls expand the window on demand.
const HUNK_PAGE = 40; // hunks rendered per page
const HUNK_LINE_CAP = 500; // lines rendered for one hunk before "show more lines"

export default function DiffViewer({
  sessions,
  bundle,
  currentId,
  embedded = false,
  focusEventId,
  focusFileId,
  focusHunkId,
  onJumpToEvent,
}: Props) {
  const router = useRouter();
  const s = bundle.session;
  const files = bundle.changedFiles;

  /* ---- state -------------------------------------------------------------- */

  // The file + hunk a given event produced (via attribution) — powers the
  // transcript→diff jump (focusEventId) and the diff→transcript back-link.
  const focusHit = useMemo(() => {
    if (focusHunkId) {
      for (const f of files) {
        const hs = bundle.hunks[f.id] ?? [];
        const hi = hs.findIndex((h) => h.id === focusHunkId);
        if (hi >= 0) {
          const eventId = (bundle.attributions[hs[hi].id] ?? []).find((a) => a.eventId)?.eventId ?? null;
          return { fileId: f.id, hunkIndex: hi, hunkId: hs[hi].id, eventId };
        }
      }
    }
    if (!focusEventId) return null;
    for (const f of files) {
      const hs = bundle.hunks[f.id] ?? [];
      const hi = hs.findIndex((h) =>
        (bundle.attributions[h.id] ?? []).some((a) => a.eventId === focusEventId)
      );
      if (hi >= 0) return { fileId: f.id, hunkIndex: hi, hunkId: hs[hi].id, eventId: focusEventId };
    }
    return null;
  }, [focusEventId, focusHunkId, files, bundle.hunks, bundle.attributions]);

  // Active file: the focused event's file if we jumped in; else a mixed-confidence
  // file; else the first.
  const initialFileId = useMemo(() => {
    if (focusHit) return focusHit.fileId;
    if (focusFileId && files.some((f) => f.id === focusFileId)) return focusFileId;
    const mixed = files.find((f) => f.path.endsWith("globals.css"));
    return (mixed ?? files[0])?.id ?? "";
  }, [files, focusFileId, focusHit]);

  const [activeFileId, setActiveFileId] = useState<string>(initialFileId);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [hunkIndex, setHunkIndex] = useState<number>(focusHit?.hunkIndex ?? 0);
  // step focus: when a turn (linked event) is selected, collapse hunks from
  // OTHER turns so the selected step's change stands alone. Toggle to All.
  const [showAllHunks, setShowAllHunks] = useState<boolean>(false);
  const [selectedLinkedEventId, setSelectedLinkedEventId] =
    useState<string | null>(focusHit?.eventId ?? focusEventId ?? null);
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [copied, setCopied] = useState<string | null>(null);
  // How many of the active file's hunks are currently mounted (pagination), and
  // which individually-capped long hunks the user expanded to full length.
  const [hunkWindow, setHunkWindow] = useState<number>(HUNK_PAGE);
  const [expandedHunks, setExpandedHunks] = useState<Set<string>>(() => new Set());
  // Hunk index to scroll to once the render window has grown to include it.
  const pendingScrollRef = useRef<number | null>(null);

  // When the session (props) changes, reset per-session UI state.
  useEffect(() => {
    setActiveFileId(initialFileId);
    setHunkIndex(focusHit?.hunkIndex ?? 0);
    setSelectedLinkedEventId(focusHit?.eventId ?? focusEventId ?? null);
    setShowRawJson(false);
    setShowAllHunks(!!focusHunkId);
    setCollapsedFolders(new Set());
  }, [currentId, initialFileId, focusHit, focusEventId, focusFileId, focusHunkId]);

  /* ---- derived: active file + its hunks / attributions / events ---------- */

  const active: ChangedFile | undefined = useMemo(
    () => files.find((f) => f.id === activeFileId) ?? files[0],
    [files, activeFileId]
  );

  const hunks: DiffHunk[] = active ? bundle.hunks[active.id] ?? [] : [];

  // Only the first `hunkWindow` hunks are mounted; the rest load via "show more"
  // (or automatically when navigation/coverage jumps past the window).
  const renderedHunks = hunks.slice(0, hunkWindow);
  const moreHunks = hunks.length - renderedHunks.length;

  // Reset diff pagination whenever the active file changes (new file/session) so
  // a previously expanded window doesn't carry into a fresh, possibly huge file.
  // When we jumped in from the transcript (focusEventId) and the target hunk is
  // past the first page, grow the window to include it and scroll there.
  useEffect(() => {
    const focusIdx =
      focusHit && focusHit.fileId === active?.id ? focusHit.hunkIndex : 0;
    setHunkWindow(Math.max(HUNK_PAGE, focusIdx + 1));
    setExpandedHunks(new Set());
    pendingScrollRef.current = focusIdx > 0 ? focusIdx : null;
  }, [active?.id, focusHit]);

  // per-hunk attribution (first attribution row drives the hunk's confidence).
  const hunkAttr = useMemo(() => {
    const m = new Map<string, Attribution | undefined>();
    for (const h of hunks) m.set(h.id, (bundle.attributions[h.id] ?? [])[0]);
    return m;
  }, [hunks, bundle.attributions]);

  const linkedEvents: LinkedEvent[] = active
    ? bundle.linkedEvents[active.id] ?? []
    : [];

  const touchedSteps = useMemo(() => {
    const seen = new Set<string>();
    const out: LinkedEvent[] = [];
    for (const le of linkedEvents) {
      if (seen.has(le.event.id)) continue;
      seen.add(le.event.id);
      out.push(le);
    }
    return out;
  }, [linkedEvents]);

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

  // After the window grows to include a navigated-to hunk, scroll it into view.
  useEffect(() => {
    const idx = pendingScrollRef.current;
    if (idx == null) return;
    const el = hunkRefs.current[idx];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pendingScrollRef.current = null;
    }
  }, [hunkWindow]);

  function gotoHunk(next: number) {
    if (hunks.length === 0) return;
    const clamped = Math.min(Math.max(0, next), hunks.length - 1);
    setHunkIndex(clamped);
    if (clamped >= hunkWindow) {
      // Grow the render window to include the target, then scroll once mounted.
      setHunkWindow(clamped + 1);
      pendingScrollRef.current = clamped;
      return;
    }
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

  // Reveal the rest of a single very long hunk that was line-capped for perf.
  function expandHunk(id: string) {
    setExpandedHunks((prev) => {
      const next = new Set(prev);
      next.add(id);
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
      {!embedded && (
        <>
      {/* metrics band */}
      <div className="sessbar" data-testid="sessbar">
        <div className="sessbar-id" data-testid="sessbar-id">
          <span className={`runner-dot ${runnerClass}`} data-testid="runner-dot" aria-hidden />
          <span className="sessbar-title" data-testid="sessbar-title" title={s.title}>
            {s.title}
          </span>
          {s.errorCount > 0 && (
            <span className="badge err" data-testid="badge" title={`${s.errorCount} failed tool call(s) in this session`}>
              {s.errorCount} error{s.errorCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="sessbar-meta" data-testid="sessbar-meta">
            Git diff · {runnerLabel} · <span className="mono" data-testid="mono">⎇ {branch}</span> · {commitText} ·{" "}
            {s.startedAt.replace("T", " ").slice(0, 16)}
          </span>
        </div>
        <div className="sessbar-stats" data-testid="sessbar-stats">
          <div className="kstat" data-testid="kstat">
            <b>{fmtInt(files.length)}</b>
            <span>files</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{fmtDuration(s.durationMs)}</b>
            <span>duration</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{fmtInt(s.turnCount)}</b>
            <span>turns</span>
          </div>
          <div
            className="kstat" data-testid="kstat"
            title={`${fmtInt(s.tokenIn)} in · ${fmtInt(s.tokenOut)} out`}
          >
            <b>{fmtCompact(s.tokenIn + s.tokenOut)}</b>
            <span>tokens</span>
          </div>
        </div>
      </div>

      {/* tab strip — active = Git. Session picker lives at the right so session
          switching stays reachable from this screen (the only navigation). */}
      <div className="tabs" data-testid="tabs" role="tablist">
        {(
          [
            ["transcript", "Transcript"],
            ["tools", "Tools"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={false}
            data-tab={key}
            className="tab" data-testid="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="tab active" data-testid="tab" role="tab" aria-selected={true} data-tab="git">Git</span>
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
            role="tab"
            aria-selected={false}
            data-tab={key}
            className="tab" data-testid="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="tabs-spacer" data-testid="tabs-spacer" />
        <span className="tabs-tool" data-testid="tabs-tool">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span className="muted small" data-testid="muted">Session</span>
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
        </>
      )}

      {/* 3-col diff working area (the only part shown when embedded in a host shell) */}
      <div
        className={embedded ? "diff-embed" : "layout3 diffview"}
        data-testid={embedded ? "diff-embed" : "layout3"}
        style={embedded ? undefined : { gridTemplateColumns: "280px minmax(0,1fr) 340px" }}
      >
        {/* COLUMN 1 — changed-files tree */}
        <div className="sidebar" data-testid="sidebar">
          <div className="filetree-head" data-testid="filetree-head">
            <div className="title" data-testid="title">Changed Files</div>
            <div className="sub" data-testid="sub">{files.length} files changed</div>
          </div>
          <div className="filetree" data-testid="filetree">
            {visibleTree.map((row, i) => {
              if (row.kind === "folder") {
                const collapsed = collapsedFolders.has(row.path);
                return (
                  <div
                    key={`folder-${row.path}-${i}`}
                    data-row-kind="folder"
                    className={`file-row is-folder ${indentClass(row.depth)}`} data-testid="file-row"
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
                    <span className="twisty" data-testid="twisty">{collapsed ? "▸" : "▾"}</span>
                    <span className="ficon folder" data-testid="ficon" data-ficon-kind="folder" aria-hidden>
                      <FolderIcon />
                    </span>
                    <span className="fname" data-testid="fname" title={row.path}>
                      {row.name}
                    </span>
                    <span className="counts" data-testid="counts">
                      <span className="add" data-testid="add">+{row.additions}</span>
                      <span className="del" data-testid="del">-{row.deletions}</span>
                    </span>
                  </div>
                );
              }
              const f = row.file;
              const isActive = !!active && f.id === active.id;
              return (
                <div
                  key={f.id}
                  data-file-id={f.id}
                  data-row-kind="file"
                  data-active={isActive ? "true" : undefined}
                  className={`file-row is-file ${indentClass(row.depth)}${
                    isActive ? " active" : ""
                  }`} data-testid="file-row"
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
                  <span className="twisty" data-testid="twisty" />
                  <span className={`status-chip ${f.status}`} data-testid="status-chip" data-status={f.status} title={f.status} aria-hidden>
                    {statusGlyph(f.status)}
                  </span>
                  <span className="fname" data-testid="fname" title={f.path}>
                    {basename(f.path)}
                  </span>
                  <span className="counts" data-testid="counts">
                    <span className="add" data-testid="add">+{f.additions}</span>
                    <span className="del" data-testid="del">-{f.deletions}</span>
                  </span>
                </div>
              );
            })}
            {files.length === 0 && (
              <div className="empty" data-testid="empty" style={{ padding: 12 }}>
                No changed files in this session.
              </div>
            )}
          </div>
        </div>

        {/* COLUMN 2 — diff for the active file */}
        <div className="main" data-testid="main">
          <div className="diff-wrap" data-testid="diff-wrap">
            <div className="diff-toolbar" data-testid="diff-toolbar">
              <span className="fpath" data-testid="fpath">{active ? active.path : "—"}</span>
              <span className="fstats" data-testid="fstats">
                <span className="add" data-testid="add">{active ? active.additions : 0} additions</span>
                {" / "}
                <span className="del" data-testid="del">{active ? active.deletions : 0} deletions</span>
              </span>
              <span className="spacer" data-testid="spacer" />
              {selected && hunks.length > 1 && (
                <span
                  className="segmented step-filter" data-testid="step-filter"
                  title="Focus the selected step's change, or show the whole file"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!showAllHunks}
                    className={!showAllHunks ? "active" : ""}
                    onClick={() => setShowAllHunks(false)}
                  >
                    This step
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showAllHunks}
                    className={showAllHunks ? "active" : ""}
                    onClick={() => setShowAllHunks(true)}
                  >
                    All changes
                  </button>
                </span>
              )}
              <span className="segmented" data-testid="segmented" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "unified"}
                  className={viewMode === "unified" ? "active" : ""}
                  onClick={() => setViewMode("unified")}
                >
                  Unified
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "split"}
                  className={viewMode === "split" ? "active" : ""}
                  onClick={() => setViewMode("split")}
                >
                  Split
                </button>
              </span>
            </div>

            {touchedSteps.length > 0 && (
              <div className="file-touched-steps" data-testid="file-touched-steps">
                <span className="muted small" data-testid="muted">Touched steps</span>
                {touchedSteps.map((le) => (
                  <button
                    key={le.event.id}
                    type="button"
                    className="file-touched-step" data-testid="file-touched-step"
                    onClick={() => {
                      setSelectedLinkedEventId(le.event.id);
                      setShowRawJson(false);
                      if (onJumpToEvent) onJumpToEvent(le.event.id);
                    }}
                    title={le.event.title}
                  >
                    step {le.event.seq}
                  </button>
                ))}
              </div>
            )}

            <div className="hunk-nav" data-testid="hunk-nav">
              <button
                type="button"
                className="nav-btn" data-testid="nav-btn"
                aria-label="prev hunk"
                onClick={() => gotoHunk(hunkIndex - 1)}
                disabled={hunks.length === 0 || hunkIndex === 0}
              >
                ‹
              </button>
              <button
                type="button"
                className="nav-btn" data-testid="nav-btn"
                aria-label="next hunk"
                onClick={() => gotoHunk(hunkIndex + 1)}
                disabled={hunks.length === 0 || hunkIndex >= hunks.length - 1}
              >
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

            <div className="diff" data-testid="diff">
              {renderedHunks.map((h, hi) => {
                const attr = hunkAttr.get(h.id);
                const conf: Confidence = attr ? attr.confidence : "unattributed";
                const method: AttributionMethod = attr
                  ? attr.method
                  : "dirty_worktree";
                const linked = attr != null && attr.eventId != null;
                const { oldNo: oldStart, newNo: newStart } = hunkStart(h.header);
                // Cap a single very long hunk (e.g. a whole-file Write) so it
                // doesn't mount thousands of rows; the tail loads on demand.
                const allLines = h.content.split("\n");
                const lines = expandedHunks.has(h.id)
                  ? allLines
                  : allLines.slice(0, HUNK_LINE_CAP);
                const moreLines = allLines.length - lines.length;
                const isCurrent = hi === hunkIndex;

                // step focus: collapse hunks attributed to OTHER turns so the
                // selected step's change stands alone (toggle via "All changes").
                const hunkEventId = attr?.eventId ?? null;
                if (
                  !showAllHunks &&
                  selected != null &&
                  hunkEventId !== selected.event.id
                ) {
                  const adds = lines.filter((l) => l.startsWith("+")).length;
                  const dels = lines.filter((l) => l.startsWith("-")).length;
                  return (
                    <div
                      key={h.id}
                      className="diff-hunk collapsed" data-testid="diff-hunk"
                      data-hunk-id={h.id}
                      data-hunk-seq={h.seq}
                      data-hunk-state="collapsed"
                      role="button"
                      tabIndex={0}
                      onClick={() => hunkEventId && setSelectedLinkedEventId(hunkEventId)}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && hunkEventId) {
                          e.preventDefault();
                          setSelectedLinkedEventId(hunkEventId);
                        }
                      }}
                      title="Change from another step — click to focus it (or use All changes)"
                    >
                      <span className="htext" data-testid="htext">{h.header}</span>
                      <span className="collapsed-note" data-testid="collapsed-note">
                        +{adds} −{dels} · another step&apos;s change — click to view
                      </span>
                    </div>
                  );
                }

                return (
                  <div
                    className={`diff-hunk${isCurrent ? " active" : ""}`} data-testid="diff-hunk"
                    key={h.id}
                    data-hunk-id={h.id}
                    data-hunk-seq={h.seq}
                    data-hunk-state={isCurrent ? "active" : "expanded"}
                    ref={(el) => {
                      hunkRefs.current[hi] = el;
                    }}
                    style={
                      isCurrent
                        ? { boxShadow: "inset 0 0 0 2px var(--accent-ring)" }
                        : undefined
                    }
                  >
                    <div className="diff-header" data-testid="diff-header">
                      <span className="htext" data-testid="htext">{h.header}</span>
                      <span className="le-right" data-testid="le-right">
                        <span className={`confidence ${conf}`} data-testid="confidence">
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
                              }`} data-testid="diff-line"
                              key={`${h.id}-${li}`}
                            >
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
                                    }`} data-testid="diff-line"
                                    key={`L-${h.id}-${ri}`}
                                    style={{
                                      gridTemplateColumns: "44px 16px 1fr",
                                    }}
                                  >
                                    <span className="lno" data-testid="lno">
                                      {L.no != null ? L.no : ""}
                                    </span>
                                    <span className="marker" data-testid="marker">
                                      {L.cls === "del" ? "-" : " "}
                                    </span>
                                    <span className="ltext" data-testid="ltext">{L.text}</span>
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
                                    }${linked ? " linked" : ""}`} data-testid="diff-line"
                                    key={`R-${h.id}-${ri}`}
                                    style={{
                                      gridTemplateColumns: "44px 16px 1fr",
                                    }}
                                  >
                                    <span className="lno diff-gutter" data-testid="lno">
                                      {R.no != null ? R.no : ""}
                                      {showNode && (
                                        <span className="diff-attr-node" data-testid="diff-attr-node" />
                                      )}
                                    </span>
                                    <span className="marker" data-testid="marker">
                                      {R.cls === "add" ? "+" : " "}
                                    </span>
                                    <span className="ltext" data-testid="ltext">{R.text}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()
                    )}
                    {moreLines > 0 && (
                      <div className="diff-more-lines" data-testid="diff-more-lines">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost" data-testid="btn"
                          onClick={() => expandHunk(h.id)}
                        >
                          Show {fmtInt(moreLines)} more line
                          {moreLines === 1 ? "" : "s"} in this hunk
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {moreHunks > 0 && (
                <div className="diff-more" data-testid="diff-more">
                  <span className="muted small" data-testid="muted">
                    Showing {fmtInt(renderedHunks.length)} of {fmtInt(hunks.length)}{" "}
                    hunks
                  </span>
                  <span style={{ flex: "1 1 auto" }} />
                  <button
                    type="button"
                    className="btn btn-sm" data-testid="btn"
                    onClick={() =>
                      setHunkWindow((w) => Math.min(hunks.length, w + HUNK_PAGE))
                    }
                  >
                    Show {Math.min(HUNK_PAGE, moreHunks)} more
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost" data-testid="btn"
                    onClick={() => setHunkWindow(hunks.length)}
                  >
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

        {/* COLUMN 3 — attribution aside */}
        <div className="aside" data-testid="aside">
          {showBanner && (
            <div className="attr-banner" data-testid="attr-banner">
              <span className="bi" data-testid="bi">⚠</span>
              <span>
                Some changes were made after shell commands; attribution is
                probabilistic.
              </span>
            </div>
          )}

          <div className="linked-events" data-testid="linked-events">
            <div className="panel-title" data-testid="panel-title">
              Linked Events <span className="count" data-testid="count">({linkedEvents.length})</span>
              {hunks.length > 0 && (
                <span className="muted small" data-testid="muted"> · {coveredCount}/{hunks.length} hunks linked</span>
              )}
            </div>
            {linkedEvents.map((le, i) => {
              const isActive =
                !!selected && le.event.id === selected.event.id;
              return (
                <div
                  key={`${le.event.id}-${le.hunkId}-${i}`}
                  className={`linked-event${isActive ? " active" : ""}`} data-testid="linked-event"
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
                  <span className="le-idx" data-testid="le-idx">{i + 1}</span>
                  <div className="le-body" data-testid="le-body">
                    <div className="le-turn" data-testid="le-turn">
                      <b>Turn {le.event.seq}:</b> {le.event.title}
                    </div>
                    <div className="le-meta" data-testid="le-meta">
                      <span className={`confidence ${le.confidence}`} data-testid="confidence">
                        {methodLabel(le.method)}
                      </span>
                      <span className="le-conf" data-testid="le-conf">{confidenceLabel(le.confidence)}</span>
                    </div>
                  </div>
                  {onJumpToEvent && (
                    <button
                      type="button"
                      className="le-jump" data-testid="le-jump"
                      title="Jump to the transcript step that produced this hunk"
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToEvent(le.event.id);
                      }}
                    >
                      ↩ step {le.event.seq}
                    </button>
                  )}
                </div>
              );
            })}
            {linkedEvents.length === 0 && (
              <div className="empty" data-testid="empty">No linked events.</div>
            )}
          </div>

          {/* Event Details for the selected linked event */}
          {selected && selectedEvent && (
            <>
              <div
                className="panel-title" data-testid="panel-title"
                style={{ padding: "0 14px", margin: "4px 0 0" }}
              >
                Event Details
              </div>
              <dl className="kv" data-testid="kv">
                <dt>Time</dt>
                <dd className="v mono" data-testid="v">{selectedEvent.ts}</dd>
                <dt>Tool</dt>
                <dd className="v mono" data-testid="v">{toolName(selectedEvent, selected.method)}</dd>
                <dt>Path</dt>
                <dd className="v mono" data-testid="v">
                  {selectedEvent.filePath ?? active?.path ?? "—"}
                </dd>
                <dt>Exit code</dt>
                <dd className="v mono" data-testid="v">
                  {selectedEvent.exitCode != null ? selectedEvent.exitCode : "0"}
                </dd>
                <dt>Latency</dt>
                <dd className="v mono" data-testid="v">{fmtLatency(selectedEvent.durationMs)}</dd>
              </dl>
              <div
                className="diff-toolbar" data-testid="diff-toolbar"
                style={{ borderBottom: "none", paddingTop: 4 }}
              >
                <span className="fstats" data-testid="fstats">
                  <span className="add" data-testid="add">+{active ? active.additions : 0}</span>
                  {" / "}
                  <span className="del" data-testid="del">-{active ? active.deletions : 0}</span>
                </span>
                <span className="spacer" data-testid="spacer" />
                <button
                  type="button"
                  className="btn btn-sm" data-testid="btn"
                  onClick={() => setShowRawJson((v) => !v)}
                >
                  {"{}"} Raw JSON
                </button>
              </div>
              {showRawJson && (
                <pre
                  className="run-json" data-testid="run-json"
                  style={{ margin: "0 14px 10px", whiteSpace: "pre-wrap" }}
                >
                  {rawJson}
                </pre>
              )}
            </>
          )}

          {/* attribution notes (annotations) */}
          {annotations.length > 0 && (
            <div className="annotations" data-testid="annotations">
              <div className="ahead" data-testid="ahead">
                Attribution notes{" "}
                <span className="count" data-testid="count">({annotations.length})</span>
              </div>
              {annotations.map((a) => (
                <div className="annotation" data-testid="annotation" key={a.id}>
                  <span className={`akind ${a.kind}`} data-testid="akind" />
                  <span className="nowrap" data-testid="nowrap">{a.note ?? a.kind}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* bottom: real time ribbon — each segment's width is the wall-clock time
          until the next step, so long operations/waits are visibly wide. */}
      {!embedded && (
        <TimeRibbon
          events={bundle.events}
          selectedId={selectedEvent?.id}
          title="Time spent (session)"
        />
      )}
    </>
  );
}
