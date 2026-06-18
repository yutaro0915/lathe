"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TimeRibbon from "@/components/TimeRibbon";
import { DiffWorkspace } from "@/components/diff-viewer/DiffWorkspace";
import { StandaloneChrome } from "@/components/diff-viewer/StandaloneChrome";
import {
  HUNK_PAGE,
  buildTree,
  hunkAttributionMap,
  rawEventJson,
  type ViewMode,
} from "@/components/diff-viewer/model";
import type {
  ChangedFile,
  DiffHunk,
  LinkedEvent,
  Session,
  SessionBundle,
  TranscriptEvent,
} from "@/lib/types";

interface Props {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
  embedded?: boolean;
  focusEventId?: string;
  focusFileId?: string;
  focusHunkId?: string;
  onJumpToEvent?: (eventId: string) => void;
}

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
  const session = bundle.session;
  const files = bundle.changedFiles;

  const focusHit = useMemo(() => {
    if (focusHunkId) {
      for (const file of files) {
        const hunks = bundle.hunks[file.id] ?? [];
        const hunkIndex = hunks.findIndex((hunk) => hunk.id === focusHunkId);
        if (hunkIndex >= 0) {
          const eventId = (bundle.attributions[hunks[hunkIndex].id] ?? []).find((a) => a.eventId)?.eventId ?? null;
          return { fileId: file.id, hunkIndex, hunkId: hunks[hunkIndex].id, eventId };
        }
      }
    }
    if (!focusEventId) return null;
    for (const file of files) {
      const hunks = bundle.hunks[file.id] ?? [];
      const hunkIndex = hunks.findIndex((hunk) =>
        (bundle.attributions[hunk.id] ?? []).some((a) => a.eventId === focusEventId),
      );
      if (hunkIndex >= 0) return { fileId: file.id, hunkIndex, hunkId: hunks[hunkIndex].id, eventId: focusEventId };
    }
    return null;
  }, [focusEventId, focusHunkId, files, bundle.hunks, bundle.attributions]);

  const initialFileId = useMemo(() => {
    if (focusHit) return focusHit.fileId;
    if (focusFileId && files.some((file) => file.id === focusFileId)) return focusFileId;
    const mixed = files.find((file) => file.path.endsWith("globals.css"));
    return (mixed ?? files[0])?.id ?? "";
  }, [files, focusFileId, focusHit]);

  const [activeFileId, setActiveFileId] = useState<string>(initialFileId);
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [hunkIndex, setHunkIndex] = useState<number>(focusHit?.hunkIndex ?? 0);
  const [showAllHunks, setShowAllHunks] = useState<boolean>(false);
  const [selectedLinkedEventId, setSelectedLinkedEventId] = useState<string | null>(focusHit?.eventId ?? focusEventId ?? null);
  const [showRawJson, setShowRawJson] = useState<boolean>(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [hunkWindow, setHunkWindow] = useState<number>(HUNK_PAGE);
  const [expandedHunks, setExpandedHunks] = useState<Set<string>>(() => new Set());
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pendingScrollRef = useRef<number | null>(null);

  useEffect(() => {
    setActiveFileId(initialFileId);
    setHunkIndex(focusHit?.hunkIndex ?? 0);
    setSelectedLinkedEventId(focusHit?.eventId ?? focusEventId ?? null);
    setShowRawJson(false);
    setShowAllHunks(!!focusHunkId);
    setCollapsedFolders(new Set());
  }, [currentId, initialFileId, focusHit, focusEventId, focusFileId, focusHunkId]);

  const active: ChangedFile | undefined = useMemo(
    () => files.find((file) => file.id === activeFileId) ?? files[0],
    [files, activeFileId],
  );
  const hunks: DiffHunk[] = active ? bundle.hunks[active.id] ?? [] : [];
  const renderedHunks = hunks.slice(0, hunkWindow);
  const moreHunks = hunks.length - renderedHunks.length;

  useEffect(() => {
    const focusIdx = focusHit && focusHit.fileId === active?.id ? focusHit.hunkIndex : 0;
    setHunkWindow(Math.max(HUNK_PAGE, focusIdx + 1));
    setExpandedHunks(new Set());
    pendingScrollRef.current = focusIdx > 0 ? focusIdx : null;
  }, [active?.id, focusHit]);

  const hunkAttr = useMemo(
    () => hunkAttributionMap(hunks, bundle.attributions),
    [hunks, bundle.attributions],
  );
  const linkedEvents: LinkedEvent[] = active ? bundle.linkedEvents[active.id] ?? [] : [];
  const touchedSteps = useMemo(() => {
    const seen = new Set<string>();
    const out: LinkedEvent[] = [];
    for (const linkedEvent of linkedEvents) {
      if (seen.has(linkedEvent.event.id)) continue;
      seen.add(linkedEvent.event.id);
      out.push(linkedEvent);
    }
    return out;
  }, [linkedEvents]);
  const selected: LinkedEvent | undefined = useMemo(() => {
    if (selectedLinkedEventId) {
      const hit = linkedEvents.find((linkedEvent) => linkedEvent.event.id === selectedLinkedEventId);
      if (hit) return hit;
    }
    return linkedEvents[0];
  }, [linkedEvents, selectedLinkedEventId]);
  const selectedEvent: TranscriptEvent | undefined = selected?.event;

  const coveredCount = hunks.filter((hunk) => {
    const attr = hunkAttr.get(hunk.id);
    return attr != null && attr.eventId != null;
  }).length;
  const showBanner = hunks.some((hunk) => {
    const attr = hunkAttr.get(hunk.id);
    return attr == null || attr.confidence !== "high";
  });

  const tree = useMemo(() => buildTree(files), [files]);
  const visibleTree = useMemo(() => {
    return tree.filter((row) => {
      const ownerDir = row.kind === "folder" ? row.path : row.dir;
      for (const collapsed of collapsedFolders) {
        if (ownerDir === collapsed || ownerDir.startsWith(`${collapsed}/`)) {
          if (row.kind === "folder" && row.path === collapsed) continue;
          return false;
        }
      }
      return true;
    });
  }, [tree, collapsedFolders]);

  useEffect(() => {
    setHunkIndex((index) => Math.min(Math.max(0, index), Math.max(0, hunks.length - 1)));
  }, [hunks.length]);

  useEffect(() => {
    const index = pendingScrollRef.current;
    if (index == null) return;
    const element = hunkRefs.current[index];
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pendingScrollRef.current = null;
    }
  }, [hunkWindow]);

  function gotoHunk(next: number) {
    if (hunks.length === 0) return;
    const clamped = Math.min(Math.max(0, next), hunks.length - 1);
    setHunkIndex(clamped);
    if (clamped >= hunkWindow) {
      setHunkWindow(clamped + 1);
      pendingScrollRef.current = clamped;
      return;
    }
    hunkRefs.current[clamped]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

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

  function expandHunk(id: string) {
    setExpandedHunks((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function switchSession(id: string) {
    if (id !== currentId) router.push(`/diff?session=${id}`);
  }

  return (
    <>
      {!embedded && (
        <StandaloneChrome
          sessions={sessions}
          current={session}
          currentId={currentId}
          files={files}
          onSwitchSession={switchSession}
        />
      )}
      <DiffWorkspace
        active={active}
        annotations={bundle.annotations}
        collapsedFolders={collapsedFolders}
        coveredCount={coveredCount}
        embedded={embedded}
        expandedHunks={expandedHunks}
        files={files}
        hunkAttr={hunkAttr}
        hunkIndex={hunkIndex}
        hunkRefs={hunkRefs}
        hunks={hunks}
        linkedEvents={linkedEvents}
        moreHunks={moreHunks}
        rawJson={rawEventJson(selectedEvent, selected)}
        renderedHunks={renderedHunks}
        selected={selected}
        selectedEvent={selectedEvent}
        showAllHunks={showAllHunks}
        showBanner={showBanner}
        showRawJson={showRawJson}
        touchedSteps={touchedSteps}
        viewMode={viewMode}
        visibleTree={visibleTree}
        onExpandHunk={expandHunk}
        onGotoHunk={gotoHunk}
        onJumpToEvent={onJumpToEvent}
        onSelectFile={selectFile}
        onSetHunkWindow={setHunkWindow}
        onSetSelectedLinkedEventId={setSelectedLinkedEventId}
        onSetShowAllHunks={setShowAllHunks}
        onSetShowRawJson={setShowRawJson}
        onSetViewMode={setViewMode}
        onToggleFolder={toggleFolder}
      />
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
