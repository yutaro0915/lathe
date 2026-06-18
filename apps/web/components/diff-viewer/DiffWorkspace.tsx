"use client";

import type { Annotation, Attribution, ChangedFile, DiffHunk, LinkedEvent, TranscriptEvent } from "@/lib/types";
import { AttributionPane } from "./AttributionPane";
import { DiffPane } from "./DiffPane";
import { FileTree } from "./FileTree";
import type { TreeRow, ViewMode } from "./model";

export function DiffWorkspace({
  active,
  annotations,
  collapsedFolders,
  coveredCount,
  embedded,
  expandedHunks,
  files,
  hunkAttr,
  hunkIndex,
  hunkRefs,
  hunks,
  linkedEvents,
  moreHunks,
  rawJson,
  renderedHunks,
  selected,
  selectedEvent,
  showAllHunks,
  showBanner,
  showRawJson,
  touchedSteps,
  viewMode,
  visibleTree,
  onExpandHunk,
  onGotoHunk,
  onJumpToEvent,
  onSelectFile,
  onSetHunkWindow,
  onSetSelectedLinkedEventId,
  onSetShowAllHunks,
  onSetShowRawJson,
  onSetViewMode,
  onToggleFolder,
}: {
  active: ChangedFile | undefined;
  annotations: Annotation[];
  collapsedFolders: Set<string>;
  coveredCount: number;
  embedded: boolean;
  expandedHunks: Set<string>;
  files: ChangedFile[];
  hunkAttr: Map<string, Attribution | undefined>;
  hunkIndex: number;
  hunkRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  hunks: DiffHunk[];
  linkedEvents: LinkedEvent[];
  moreHunks: number;
  rawJson: string;
  renderedHunks: DiffHunk[];
  selected: LinkedEvent | undefined;
  selectedEvent: TranscriptEvent | undefined;
  showAllHunks: boolean;
  showBanner: boolean;
  showRawJson: boolean;
  touchedSteps: LinkedEvent[];
  viewMode: ViewMode;
  visibleTree: TreeRow[];
  onExpandHunk: (id: string) => void;
  onGotoHunk: (next: number) => void;
  onJumpToEvent?: (eventId: string) => void;
  onSelectFile: (id: string) => void;
  onSetHunkWindow: React.Dispatch<React.SetStateAction<number>>;
  onSetSelectedLinkedEventId: (id: string) => void;
  onSetShowAllHunks: (value: boolean) => void;
  onSetShowRawJson: React.Dispatch<React.SetStateAction<boolean>>;
  onSetViewMode: (value: ViewMode) => void;
  onToggleFolder: (path: string) => void;
}) {
  return (
    <div
      className={embedded ? "diff-embed" : "lds-layout3 lds-layout3--diffview"}
      data-testid={embedded ? "diff-embed" : "layout3"}
      style={embedded ? undefined : { gridTemplateColumns: "280px minmax(0,1fr) 340px" }}
    >
      <FileTree
        files={files}
        active={active}
        visibleTree={visibleTree}
        collapsedFolders={collapsedFolders}
        onToggleFolder={onToggleFolder}
        onSelectFile={onSelectFile}
      />
      <DiffPane
        active={active}
        hunks={hunks}
        renderedHunks={renderedHunks}
        moreHunks={moreHunks}
        hunkAttr={hunkAttr}
        hunkRefs={hunkRefs}
        hunkIndex={hunkIndex}
        selected={selected}
        showAllHunks={showAllHunks}
        viewMode={viewMode}
        touchedSteps={touchedSteps}
        expandedHunks={expandedHunks}
        onSetShowAllHunks={onSetShowAllHunks}
        onSetViewMode={onSetViewMode}
        onSetSelectedLinkedEventId={onSetSelectedLinkedEventId}
        onJumpToEvent={onJumpToEvent}
        onGotoHunk={onGotoHunk}
        onExpandHunk={onExpandHunk}
        onSetHunkWindow={onSetHunkWindow}
      />
      <AttributionPane
        active={active}
        annotations={annotations}
        coveredCount={coveredCount}
        hunksLength={hunks.length}
        linkedEvents={linkedEvents}
        rawJson={rawJson}
        selected={selected}
        selectedEvent={selectedEvent}
        showBanner={showBanner}
        showRawJson={showRawJson}
        onSetSelectedLinkedEventId={onSetSelectedLinkedEventId}
        onSetShowRawJson={onSetShowRawJson}
        onJumpToEvent={onJumpToEvent}
      />
    </div>
  );
}
