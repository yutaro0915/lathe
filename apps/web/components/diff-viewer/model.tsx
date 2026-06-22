"use client";

import type {
  Attribution,
  AttributionMethod,
  DiffHunk,
  FileStatus,
} from "@/lib/types";

// model.tsx — pure helpers for the single-column diff accordion (D15/D14/D13).
// The three-pane workspace (FileTree / DiffPane / AttributionPane / DiffWorkspace)
// was retired in slice 10 (ADR-git-single-column); the tree builder, the
// split/side-by-side ViewMode, the indent helpers and the raw-event JSON helper
// went with it (unified-only, flat file list, inline attribution). What remains is
// the unified hunk math + the file/hunk → attribution lookups shared by HunkList /
// DiffFileRow / DiffViewer.

// Windowing: cap a file at HUNK_PAGE hunks and each hunk at HUNK_LINE_CAP lines so
// a huge file never blows up the DOM. "Show more hunks" / "Show more lines" widen
// the window on demand.
export const HUNK_PAGE = 40;
export const HUNK_LINE_CAP = 500;

export function methodLabel(method: AttributionMethod): string {
  switch (method) {
    case "edit_event":
      return "edit";
    case "shell_inferred":
      return "shell";
    case "external":
    case "dirty_worktree":
      return "unattributed";
  }
}

export function statusGlyph(status: FileStatus): string {
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

export function lineClass(line: string): "" | "add" | "del" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export function hunkStart(header: string): { oldNo: number; newNo: number } {
  const m = header.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
  return {
    oldNo: m ? parseInt(m[1], 10) : 1,
    newNo: m ? parseInt(m[2], 10) : 1,
  };
}

// hunk id → its primary attribution (first one wins). Used to color the inline
// `↗ Turn N · edit` link and to group hunks by producing step on the By-step axis.
export function hunkAttributionMap(
  hunks: DiffHunk[],
  attributions: Record<string, Attribution[]>,
): Map<string, Attribution | undefined> {
  const m = new Map<string, Attribution | undefined>();
  for (const h of hunks) m.set(h.id, (attributions[h.id] ?? [])[0]);
  return m;
}
