import DiffViewer from "@/components/DiffViewer";
import type { Session, SessionBundle } from "@/lib/types";

export function GitTab({
  sessions,
  bundle,
  currentId,
  focusEventId,
  focusFileId,
  focusHunkId,
  onJumpToEvent,
}: {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
  focusEventId?: string;
  focusFileId?: string;
  focusHunkId?: string;
  onJumpToEvent: (eventId: string) => void;
}) {
  return (
    <DiffViewer
      embedded
      sessions={sessions}
      bundle={bundle}
      currentId={currentId}
      focusEventId={focusEventId}
      focusFileId={focusFileId}
      focusHunkId={focusHunkId}
      onJumpToEvent={onJumpToEvent}
    />
  );
}
