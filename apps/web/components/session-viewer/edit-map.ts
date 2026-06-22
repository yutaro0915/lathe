import type { ChangedFile, DiffHunk, SessionBundle, TranscriptEvent } from "@/lib/types";

export type EditDetail = { file: ChangedFile; hunks: DiffHunk[] };

// edit detail-block data: map an edit/write event → its changed file + hunks, so
// the inline edit step can show the file path, +N −M, and the diff. Pure (no
// React); SessionViewer wraps it in a useMemo. Extracted verbatim from the
// component body so the resolution logic lives in one testable place and the
// component stays under the file-size budget (I4).
export function buildEditByEventId(bundle: SessionBundle, events: TranscriptEvent[]): Map<string, EditDetail> {
  const fileById = new Map<string, ChangedFile>();
  for (const f of bundle.changedFiles) fileById.set(f.id, f);
  // hunk → owning file (so an attribution's hunkId resolves to a file).
  const fileByHunk = new Map<string, string>();
  for (const [fileId, hunkList] of Object.entries(bundle.hunks)) {
    for (const h of hunkList) fileByHunk.set(h.id, fileId);
  }
  // event → set of file ids it produced (via hunk attributions).
  const filesByEvent = new Map<string, Set<string>>();
  for (const [hunkId, attrs] of Object.entries(bundle.attributions)) {
    const fileId = fileByHunk.get(hunkId);
    if (!fileId) continue;
    for (const a of attrs) {
      if (!a.eventId) continue;
      const set = filesByEvent.get(a.eventId) ?? new Set<string>();
      set.add(fileId);
      filesByEvent.set(a.eventId, set);
    }
  }
  const out = new Map<string, EditDetail>();
  for (const e of events) {
    if (e.type !== "file_edit" && e.type !== "file_write") continue;
    // prefer an attributed file; else match by the event's own filePath.
    let fileId: string | undefined = [...(filesByEvent.get(e.id) ?? [])][0];
    if (!fileId && e.filePath) {
      const byPath = bundle.changedFiles.find((f) => f.path === e.filePath);
      fileId = byPath?.id;
    }
    if (!fileId) continue;
    const file = fileById.get(fileId);
    if (!file) continue;
    out.set(e.id, { file, hunks: bundle.hunks[fileId] ?? [] });
  }
  return out;
}
