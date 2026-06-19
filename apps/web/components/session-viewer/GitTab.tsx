import DiffViewer from "@/components/DiffViewer";
import type { SessionBundle } from "@/lib/types";

// GitTab is the session viewer's Git tab body: it renders the diff WORKSPACE
// (DiffViewer) inside the shell-owned Surface body. The session title/meta, the
// tab nav, and the session switcher live in the WorkareaHeader (Surface), so the
// tab needs no `sessions` list of its own — switching sessions happens on the
// Sessions surface ("/"), and any old /diff?session=<id> link redirects here.
export function GitTab({
  bundle,
  currentId,
  focusEventId,
  focusFileId,
  focusHunkId,
  onJumpToEvent,
}: {
  bundle: SessionBundle;
  currentId: string;
  focusEventId?: string;
  focusFileId?: string;
  focusHunkId?: string;
  onJumpToEvent: (eventId: string) => void;
}) {
  return (
    <DiffViewer
      bundle={bundle}
      currentId={currentId}
      focusEventId={focusEventId}
      focusFileId={focusFileId}
      focusHunkId={focusHunkId}
      onJumpToEvent={onJumpToEvent}
    />
  );
}
