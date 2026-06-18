"use client";

import type {
  Attribution,
  AttributionMethod,
  ChangedFile,
  Confidence,
  DiffHunk,
  FileStatus,
  LinkedEvent,
  TranscriptEvent,
} from "@/lib/types";

export type ViewMode = "unified" | "split";

export type TreeFile = {
  kind: "file";
  file: ChangedFile;
  depth: number;
  dir: string;
};

export type TreeFolder = {
  kind: "folder";
  name: string;
  path: string;
  depth: number;
  additions: number;
  deletions: number;
};

export type TreeRow = TreeFile | TreeFolder;

export const HUNK_PAGE = 40;
export const HUNK_LINE_CAP = 500;

export function methodLabel(method: AttributionMethod): string {
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

export function toolName(
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

export function confidenceLabel(c: Confidence): string {
  switch (c) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "unattributed":
      return "unattributed";
  }
}

export function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path
        d="M1.6 4.3c0-.62.5-1.12 1.12-1.12h2.9c.3 0 .58.12.79.33l.84.84h6.04c.62 0 1.12.5 1.12 1.12v6.1c0 .62-.5 1.12-1.12 1.12H2.72c-.62 0-1.12-.5-1.12-1.12V4.3z"
        fill="currentColor"
      />
    </svg>
  );
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

export function indentClass(depth: number): string {
  if (depth <= 0) return "";
  if (depth === 1) return "indent-1";
  if (depth === 2) return "indent-2";
  if (depth === 3) return "indent-3";
  if (depth === 4) return "indent-4";
  return "indent-5";
}

export function buildTree(files: ChangedFile[]): TreeRow[] {
  if (files.length === 0) return [];
  const dirSegs = (p: string) => p.split("/").filter(Boolean).slice(0, -1);
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

  const rows: TreeRow[] = [];
  function walk(n: Node, depth: number) {
    for (const c of [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let node = c;
      let label = c.name;
      while (node.folders.size === 1 && node.files.length === 0) {
        const only = [...node.folders.values()][0];
        label = `${label}/${only.name}`;
        node = only;
      }
      rows.push({ kind: "folder", name: label, path: node.path, depth, additions: node.add, deletions: node.del });
      walk(node, depth + 1);
    }
    for (const f of [...n.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "file", file: f, depth, dir: strippedDir(f).join("/") });
    }
  }
  walk(root, 0);
  return rows;
}

export function hunkStart(header: string): { oldNo: number; newNo: number } {
  const m = header.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/);
  return {
    oldNo: m ? parseInt(m[1], 10) : 1,
    newNo: m ? parseInt(m[2], 10) : 1,
  };
}

export function rawEventJson(
  selectedEvent: TranscriptEvent | undefined,
  selected: LinkedEvent | undefined,
): string {
  if (!selectedEvent || !selected) return "";
  return JSON.stringify(
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
      confidence: selected.confidence,
      method: selected.method,
      tool: toolName(selectedEvent, selected.method),
    },
    null,
    2,
  );
}

export function hunkAttributionMap(hunks: DiffHunk[], attributions: Record<string, Attribution[]>): Map<string, Attribution | undefined> {
  const m = new Map<string, Attribution | undefined>();
  for (const h of hunks) m.set(h.id, (attributions[h.id] ?? [])[0]);
  return m;
}
