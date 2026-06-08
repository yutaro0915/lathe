// app/page.tsx — Screen A: session viewer.
//
// Thin SERVER wrapper. Loads the session list + the requested SessionBundle
// (falling back to the primary session) and renders the interactive client
// component <SessionViewer>. The client never touches lib/db.
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import {
  getSessionBundle,
  getPrimarySession,
  listSessions,
  getStats,
} from "@/lib/db";
import SessionViewer from "@/components/SessionViewer";

const TABS = ["transcript", "tools", "git", "skills", "subagents", "raw", "stats"] as const;
type Tab = (typeof TABS)[number];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sessions = listSessions();
  const req = typeof sp.session === "string" ? sp.session : undefined;
  const id = req && getSessionBundle(req) ? req : getPrimarySession().id;
  const bundle = getSessionBundle(id)!;
  // Project list is only used by the sidebar's session-list scope selector here.
  // Cross-session ANALYTICS (charts) live on /overview, not in the viewer — the
  // viewer is per-session, and cross-session aggregates would be off-topic in it.
  const stats = getStats();
  const projects = stats.projects.map((p) => ({
    project: p.project,
    sessions: p.sessions,
    cost: p.cost,
    costKnown: p.costKnown,
  }));
  const sessionProject: Record<string, string> = {};
  for (const p of stats.projects) for (const r of p.sessionRefs) sessionProject[r.id] = p.project;
  const initialTab: Tab =
    typeof sp.tab === "string" && (TABS as readonly string[]).includes(sp.tab)
      ? (sp.tab as Tab)
      : "transcript";
  return (
    <SessionViewer
      sessions={sessions}
      bundle={bundle}
      currentId={id}
      projects={projects}
      sessionProject={sessionProject}
      initialTab={initialTab}
    />
  );
}
