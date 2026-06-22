"use client";

import type { ChangedFile, DiffHunk, LinkedEvent } from "@/lib/types";
import { HunkList } from "./HunkList";
import { methodLabel, statusGlyph } from "./model";

// DiffFileRow — ONE changed file as an accordion row (the mockup's By-file shape,
// reused on the By-step axis too). Row = [chevron][file-diff status glyph]
// [path, mono, ellipsized][inline ↗ Turn N · edit attribution][+X −Y diffstat].
// Clicking the row toggles its unified hunks inline BELOW (HunkList).
//
// D14 inline attribution: the `↗ Turn N · edit` link IS the le-jump (Git →
// Transcript). It carries the `le-jump` testid + calls onJumpToEvent(eventId) so
// the bidirectional cross-link keeps working (diff.spec asserts le-jump). The
// producing step is the file's first linked event (the attribution data already
// assembled server-side: bundle.linkedEvents[fileId]).
//
// D13 +/− coloring stays INSIDE HunkList (the diff renderer); the row's diffstat
// uses clean green/red (.add / .del) and never tints the row itself.
export function DiffFileRow({
  file,
  hunks,
  linkedEvent,
  open,
  focusHunkId,
  rowTestId = "file-row",
  onToggle,
  onJumpToEvent,
}: {
  file: ChangedFile;
  hunks: DiffHunk[];
  // the producing step for THIS file (first attributed linked event), or null.
  linkedEvent: LinkedEvent | null;
  open: boolean;
  // a specific hunk to focus (findings evidence / cross-link jump), when this
  // file is the jump target — highlighted + scrolled into view by HunkList.
  focusHunkId?: string;
  rowTestId?: string;
  onToggle: () => void;
  onJumpToEvent?: (eventId: string) => void;
}) {
  return (
    <div
      className={`diff-acc-file${open ? " open" : ""}`}
      data-testid="diff-acc-file"
      data-file-id={file.id}
      data-open={open ? "true" : undefined}
    >
      <div
        className="diff-acc-row"
        data-testid={rowTestId}
        data-row-kind="file"
        data-file-id={file.id}
        data-active={open ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="diff-acc-chevron" data-testid="diff-acc-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span
          className={`status-chip ${file.status}`}
          data-testid="status-chip"
          data-status={file.status}
          title={file.status}
          aria-hidden
        >
          {statusGlyph(file.status)}
        </span>
        <span className="diff-acc-path" data-testid="fpath" data-ellipsis-ok title={file.path}>
          {file.path}
        </span>
        {linkedEvent && onJumpToEvent && (
          <button
            type="button"
            className="le-jump"
            data-testid="le-jump"
            data-event-id={linkedEvent.event.id}
            title={`Jump to the transcript step that produced this change (Turn ${linkedEvent.event.seq})`}
            onClick={(event) => {
              event.stopPropagation();
              onJumpToEvent(linkedEvent.event.id);
            }}
          >
            ↗ Turn {linkedEvent.event.seq} · {methodLabel(linkedEvent.method)}
          </button>
        )}
        <span className="diff-acc-stat" data-testid="fstats">
          <span className="add" data-testid="add">+{file.additions}</span>{" "}
          <span className="del" data-testid="del">−{file.deletions}</span>
        </span>
      </div>
      {open && (
        <div className="diff-acc-body" data-testid="diff-acc-body">
          <HunkList hunks={hunks} focusHunkId={focusHunkId} />
        </div>
      )}
    </div>
  );
}
