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
    // Always embedded in the session viewer's Git-tab body (the diff workspace =
    // file tree + hunks + attribution). The shell owns the header chrome via
    // <Surface>; this is just the three-pane workspace inside the Surface body.
    // data-scroll: the dense three-pane diff has a natural minimum width; when the
    // work area is narrower (700px gate width) the whole workspace scrolls
    // horizontally INSIDE its pane rather than clipping (the no-overflow gate
    // exempts data-scroll panes — same contract as the diff body itself).
    <div className="diff-embed" data-testid="diff-embed" data-scroll>
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
