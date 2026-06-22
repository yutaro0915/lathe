"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtInt } from "@lathe/shared";
import { Icon } from "@/components/ds/icons";
import { DiffFileRow } from "@/components/diff-viewer/DiffFileRow";
import { HunkList } from "@/components/diff-viewer/HunkList";
import type { ChangedFile, DiffHunk, LinkedEvent } from "@/lib/types";

// DiffViewer — the Git tab body, a SINGLE-COLUMN ACCORDION (slice 10 /
// ADR-git-single-column). It supersedes the three-pane workspace (FileTree +
// DiffPane + AttributionPane); those are retired. It renders unified-only diffs
// (D15: side-by-side dropped) with a [By step | By file] segmented over the SAME
// diff data, inline ↗ Turn N · edit attribution (D14, the le-jump back to the
// transcript), and the +/− coloring confined to the hunk renderer (D13).
//
// LIGHTWEIGHT diff list (user's stance): this is for quick code-checking, NOT a
// full Git client — deep review happens in IDE/GitHub. So it is lean: a flat file
// list (no folder tree), no split view, no raw-JSON toggle, no separate
// attribution chrome.
//
// Reused by BOTH hosts: the standalone /diff route (via GitTab) AND the slice-9
// nested mini-session (GitTab scoped to a sub-agent's kids). The component takes
// the same SessionBundle either way; the nested host passes a kid-scoped bundle.
//
// Axes (both carry file↔step attribution, D15):
//   • By file (default, mockup-detailed): a flat list of changed files; each row
//     expands its unified hunks inline. The ↗ link on a row jumps to its
//     producing step.
//   • By step (symmetric — the mockup doesn't detail it, built by the same
//     accordion shape): files grouped by their PRODUCING step; each step row
//     expands the file diffs it produced, same unified hunks. Files with no
//     attribution collect under an "Unattributed" group.
interface Props {
  bundle: {
    changedFiles: ChangedFile[];
    hunks: Record<string, DiffHunk[]>;
    linkedEvents: Record<string, LinkedEvent[]>;
  };
  currentId: string;
  focusEventId?: string;
  focusFileId?: string;
  focusHunkId?: string;
  onJumpToEvent?: (eventId: string) => void;
  showHead?: boolean;
  showAxis?: boolean;
  emptyMessage?: string;
  fileRowTestId?: string;
}

type Axis = "by-file" | "by-step";
type DiffBundle = Props["bundle"];

// the producing step for a file = its first attributed linked event (the same
// attribution data DiffPane/AttributionPane consumed). null = unattributed.
function producingEvent(bundle: DiffBundle, fileId: string): LinkedEvent | null {
  return (bundle.linkedEvents[fileId] ?? [])[0] ?? null;
}

export default function DiffViewer({
  bundle,
  currentId,
  focusEventId,
  focusFileId,
  focusHunkId,
  onJumpToEvent,
  showHead = true,
  showAxis = true,
  emptyMessage = "No changed files in this session.",
  fileRowTestId = "file-row",
}: Props) {
  const files = bundle.changedFiles;

  // Forward focus (Transcript → Git): when a focus target is passed, resolve the
  // file it lands on so we can open it. focusFileId is direct; focusHunkId /
  // focusEventId resolve through the hunk → file / attribution maps.
  const focusFile = useMemo<ChangedFile | null>(() => {
    if (focusFileId) return files.find((f) => f.id === focusFileId) ?? null;
    if (focusHunkId) {
      for (const f of files) {
        if ((bundle.hunks[f.id] ?? []).some((h) => h.id === focusHunkId)) return f;
      }
    }
    if (focusEventId) {
      for (const f of files) {
        if ((bundle.linkedEvents[f.id] ?? []).some((le) => le.event.id === focusEventId)) return f;
      }
    }
    return null;
  }, [files, focusFileId, focusHunkId, focusEventId, bundle.hunks, bundle.linkedEvents]);

  const [axis, setAxis] = useState<Axis>("by-file");
  // which file rows are open (By-file axis) — keyed by file id.
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
  // which step groups are open (By-step axis) — keyed by event id / "__none__".
  const [openSteps, setOpenSteps] = useState<Set<string>>(() => new Set());

  // On mount / session change / focus change: default-open the focused file (or
  // the first file when none is focused), so the diff lands populated.
  useEffect(() => {
    const initial = focusFile ?? files[0];
    setOpenFiles(initial ? new Set([initial.id]) : new Set());
    const ev = initial ? producingEvent(bundle, initial.id) : null;
    setOpenSteps(new Set([ev ? ev.event.id : "__none__"]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, focusFile?.id]);

  const toggleFile = (id: string) =>
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleStep = (key: string) =>
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // diffstat: N files / +X / −Y across the whole (scoped) diff.
  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { files: files.length, add, del };
  }, [files]);

  // By-step grouping: files keyed by their producing event. A single ordered list
  // of { event | null, files[] } so each step row lists the files it produced.
  const stepGroups = useMemo(() => {
    type Group = { key: string; event: LinkedEvent["event"] | null; method: LinkedEvent["method"] | null; files: ChangedFile[] };
    const byKey = new Map<string, Group>();
    const order: string[] = [];
    for (const f of files) {
      const le = producingEvent(bundle, f.id);
      const key = le ? le.event.id : "__none__";
      let g = byKey.get(key);
      if (!g) {
        g = { key, event: le ? le.event : null, method: le ? le.method : null, files: [] };
        byKey.set(key, g);
        order.push(key);
      }
      g.files.push(f);
    }
    // attributed steps first (by seq), unattributed last.
    return order
      .map((k) => byKey.get(k)!)
      .sort((a, b) => {
        if (!a.event) return 1;
        if (!b.event) return -1;
        return a.event.seq - b.event.seq;
      });
  }, [files, bundle.linkedEvents]);

  return (
    <div className="diff-acc" data-testid="diff-embed">
      {showHead ? (
        <div className="diff-acc-head" data-testid="diff-acc-head">
          {showAxis ? (
            <span className="lds-segmented diff-acc-axis" data-testid="diff-axis-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={axis === "by-step"}
                className={axis === "by-step" ? "is-active" : ""}
                data-axis="by-step"
                onClick={() => setAxis("by-step")}
              >
                <Icon name="stack" size={13} /> By step
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={axis === "by-file"}
                className={axis === "by-file" ? "is-active" : ""}
                data-axis="by-file"
                onClick={() => setAxis("by-file")}
              >
                <Icon name="folder" size={13} /> By file
              </button>
            </span>
          ) : null}
          <span style={{ flex: "1 1 auto" }} />
          <span className="diff-acc-diffstat" data-testid="diffstat">
            <span className="files" data-testid="diffstat-files">{fmtInt(totals.files)} files</span>{" "}
            <span className="add" data-testid="diffstat-add">+{fmtInt(totals.add)}</span>{" "}
            <span className="del" data-testid="diffstat-del">−{fmtInt(totals.del)}</span>
          </span>
        </div>
      ) : null}

      {files.length === 0 ? (
        <div className="empty" data-testid="empty" style={{ padding: 14 }}>
          {emptyMessage}
        </div>
      ) : !showAxis || axis === "by-file" ? (
        <div className="diff-acc-list" data-testid="diff-acc-list" data-axis="by-file">
          {files.map((f) => (
            <DiffFileRow
              key={f.id}
              file={f}
              hunks={bundle.hunks[f.id] ?? []}
              linkedEvent={producingEvent(bundle, f.id)}
              open={openFiles.has(f.id)}
              focusHunkId={focusFile?.id === f.id ? focusHunkId : undefined}
              rowTestId={fileRowTestId}
              onToggle={() => toggleFile(f.id)}
              onJumpToEvent={onJumpToEvent}
            />
          ))}
        </div>
      ) : (
        <div className="diff-acc-list" data-testid="diff-acc-list" data-axis="by-step">
          {stepGroups.map((g) => {
            const open = openSteps.has(g.key);
            return (
              <div
                key={g.key}
                className={`diff-acc-step${open ? " open" : ""}`}
                data-testid="diff-step-group"
                data-step-key={g.key}
                data-open={open ? "true" : undefined}
              >
                <div
                  className="diff-acc-row diff-acc-step-row"
                  data-testid="step-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggleStep(g.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleStep(g.key);
                    }
                  }}
                >
                  <span className="diff-acc-chevron" data-testid="diff-acc-chevron" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="diff-acc-step-label" data-testid="step-label" data-ellipsis-ok title={g.event ? g.event.title : "Unattributed changes"}>
                    {g.event ? `Turn ${g.event.seq}: ${g.event.title}` : "Unattributed"}
                  </span>
                  {g.event && onJumpToEvent && (
                    <button
                      type="button"
                      className="le-jump"
                      data-testid="le-jump"
                      data-event-id={g.event.id}
                      title={`Jump to the transcript step that produced these changes (Turn ${g.event.seq})`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onJumpToEvent(g.event!.id);
                      }}
                    >
                      ↗ step {g.event.seq}
                    </button>
                  )}
                  <span className="diff-acc-step-count" data-testid="step-file-count">
                    {fmtInt(g.files.length)} file{g.files.length === 1 ? "" : "s"}
                  </span>
                </div>
                {open && (
                  <div className="diff-acc-step-body" data-testid="step-body">
                    {g.files.map((f) => (
                      <StepFile key={f.id} file={f} hunks={bundle.hunks[f.id] ?? []} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// One file under a By-step group: a compact file header + its unified hunks (the
// step already carries the attribution, so the per-file ↗ link is omitted here —
// the symmetry is "step → its files", D15).
function StepFile({ file, hunks }: { file: ChangedFile; hunks: DiffHunk[] }) {
  return (
    <div className="diff-acc-step-file" data-testid="step-file" data-file-id={file.id}>
      <div className="diff-acc-step-fhead" data-testid="step-file-head">
        <span className="diff-acc-path" data-testid="fpath" data-ellipsis-ok title={file.path}>
          {file.path}
        </span>
        <span className="diff-acc-stat" data-testid="fstats">
          <span className="add" data-testid="add">+{file.additions}</span>{" "}
          <span className="del" data-testid="del">−{file.deletions}</span>
        </span>
      </div>
      <HunkList hunks={hunks} />
    </div>
  );
}
