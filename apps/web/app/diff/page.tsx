// app/diff/page.tsx — legacy Git-diff route, now a thin REDIRECT.
//
// The diff used to be its own page with its own (file-tree) sidebar, which
// replaced the session list and stranded you with no way to switch sessions.
// The diff is now an in-page "Git" tab inside the session viewer (the session
// list stays put), so this route just forwards to that tab. Any old /diff or
// /diff?session=<id> link keeps working.
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import {
  getSessionBundle,
  getPrimarySession,
  listSessions,
  getChangedFiles,
} from "@/lib/db";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sessions = listSessions();
  // Honor an explicit ?session. Otherwise default to the most recent session
  // that actually has file changes (the diff tab is about changes, so an empty
  // default would look broken); fall back to the primary session.
  const req =
    typeof sp.session === "string" && getSessionBundle(sp.session)
      ? sp.session
      : undefined;
  const id =
    req ??
    sessions.find((s) => getChangedFiles(s.id).length > 0)?.id ??
    getPrimarySession().id;
  redirect(`/?session=${encodeURIComponent(id)}&tab=git`);
}
