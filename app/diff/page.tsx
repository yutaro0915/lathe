// app/diff/page.tsx — Screen B route: thin SERVER wrapper.
//
// Loads the session list + the requested session's full bundle (read-only,
// server-side) and hands them to the interactive client component. Session
// switching is driven by ?session=<id> on this route (DiffViewer router.push).
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import {
  getSessionBundle,
  getPrimarySession,
  listSessions,
  getChangedFiles,
} from "@/lib/db";
import DiffViewer from "@/components/DiffViewer";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sessions = listSessions();
  // Honor an explicit ?session. Otherwise default to the most recent session
  // that actually has file changes (the diff screen is about changes, so an
  // empty default would look broken); fall back to the primary session.
  const req =
    typeof sp.session === "string" && getSessionBundle(sp.session)
      ? sp.session
      : undefined;
  const id =
    req ??
    sessions.find((s) => getChangedFiles(s.id).length > 0)?.id ??
    getPrimarySession().id;
  const bundle = getSessionBundle(id)!;
  return <DiffViewer sessions={sessions} bundle={bundle} currentId={id} />;
}
