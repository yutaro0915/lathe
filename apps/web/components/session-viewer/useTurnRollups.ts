import { useMemo } from "react";
import type { SessionBundle, TranscriptEvent } from "@/lib/types";
import type { TurnFile, TurnRollup } from "./types";
import { firstNonEmptyLine, hmsToMs } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function readMetaCostUsd(e: TranscriptEvent): number | null {
  if (!e.meta) return null;
  try {
    const meta = JSON.parse(e.meta);
    return typeof meta.costUsd === "number" ? meta.costUsd : null;
  } catch {
    return null;
  }
}

export function useChangedFilesByEvent(bundle: SessionBundle) {
  const changedFileByPath = useMemo(() => {
    const m = new Map<string, TurnFile>();
    for (const f of bundle.changedFiles) m.set(f.path, { id: f.id, path: f.path });
    return m;
  }, [bundle.changedFiles]);

  return useMemo(() => {
    const m = new Map<string, Map<string, TurnFile>>();
    const add = (eventId: string | null | undefined, file: TurnFile | undefined) => {
      if (!eventId || !file) return;
      let filesForEvent = m.get(eventId);
      if (!filesForEvent) {
        filesForEvent = new Map();
        m.set(eventId, filesForEvent);
      }
      filesForEvent.set(file.id, file);
    };

    for (const [eventId, files] of Object.entries(bundle.eventFiles)) {
      for (const f of files) add(eventId, changedFileByPath.get(f.path));
    }
    for (const f of bundle.changedFiles) {
      for (const h of bundle.hunks[f.id] ?? []) {
        for (const a of bundle.attributions[h.id] ?? []) add(a.eventId, { id: f.id, path: f.path });
      }
    }
    return m;
  }, [bundle.attributions, bundle.changedFiles, bundle.eventFiles, bundle.hunks, changedFileByPath]);
}

export function useTurnRollups({
  bundle,
  childrenByParent,
  topEvents,
  turnHeaderIds,
  turnNumberByEventId,
}: {
  bundle: SessionBundle;
  childrenByParent: Map<string, TranscriptEvent[]>;
  topEvents: TranscriptEvent[];
  turnHeaderIds: Map<string, string>;
  turnNumberByEventId: Map<string, number>;
}) {
  const changedFilesByEventId = useChangedFilesByEvent(bundle);

  return useMemo(() => {
    type MutableTurnRollup = Omit<TurnRollup, "files" | "collapsed"> & {
      fileMap: Map<string, TurnFile>;
    };

    const rollups = new Map<string, MutableTurnRollup>();
    const collect = (r: MutableTurnRollup, e: TranscriptEvent) => {
      if (e.type === "file_edit" || e.type === "file_write") r.edits += 1;
      if (e.type === "bash") r.bash += 1;
      if (e.type === "error" || (e.exitCode != null && e.exitCode !== 0)) r.errors += 1;
      r.tokens += e.tokenUsage ?? 0;
      r.durationMs += e.durationMs ?? 0;

      const directCost = readMetaCostUsd(e);
      const tokenCost =
        directCost == null && bundle.session.costUsd != null && bundle.session.tokenUsage > 0 && e.tokenUsage != null
          ? (bundle.session.costUsd * e.tokenUsage) / bundle.session.tokenUsage
          : null;
      const cost = directCost ?? tokenCost;
      if (cost != null) r.costUsd = (r.costUsd ?? 0) + cost;

      for (const file of changedFilesByEventId.get(e.id)?.values() ?? []) {
        r.fileMap.set(file.id, file);
      }
    };

    for (const e of topEvents) {
      if (e.type !== "user_message") continue;
      rollups.set(e.id, {
        turn: turnNumberByEventId.get(e.id) ?? 0,
        steps: 0,
        edits: 0,
        bash: 0,
        errors: 0,
        tokens: 0,
        durationMs: 0,
        wallDurationMs: 0,
        costUsd: null,
        fileMap: new Map(),
        summary: firstNonEmptyLine(e.body) || e.title,
      });
    }

    for (const e of topEvents) {
      const headerId = turnHeaderIds.get(e.id);
      if (!headerId) continue;
      const r = rollups.get(headerId);
      if (!r) continue;
      if (e.id !== headerId) r.steps += 1;
      collect(r, e);
      for (const child of childrenByParent.get(e.id) ?? []) collect(r, child);
    }

    const sessionStart = hmsToMs(topEvents[0]?.ts ?? "") ?? 0;
    const normalizeMs = (e: TranscriptEvent | undefined) => {
      const raw = e ? hmsToMs(e.ts) : null;
      if (raw == null) return sessionStart;
      return raw < sessionStart ? raw + DAY_MS : raw;
    };
    const headers = topEvents.filter((e) => e.type === "user_message");
    const lastTop = topEvents.at(-1);
    for (let i = 0; i < headers.length; i += 1) {
      const start = normalizeMs(headers[i]);
      const end = i + 1 < headers.length ? normalizeMs(headers[i + 1]) : normalizeMs(lastTop);
      const r = rollups.get(headers[i].id);
      if (r) r.wallDurationMs = Math.max(0, end - start);
    }

    const out = new Map<string, Omit<TurnRollup, "collapsed">>();
    for (const [headerId, r] of rollups) {
      const { fileMap, ...rest } = r;
      out.set(headerId, { ...rest, files: [...fileMap.values()] });
    }
    return out;
  }, [
    bundle.session.costUsd,
    bundle.session.tokenUsage,
    changedFilesByEventId,
    childrenByParent,
    topEvents,
    turnHeaderIds,
    turnNumberByEventId,
  ]);
}
