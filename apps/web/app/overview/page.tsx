// app/overview/page.tsx — Home / project-level analytics screen.
//
// The cross-session attention funnel: cost / error / pending-finding priorities
// first, then D31 trends (runner median cost, cost over time, findings by kind).
//
// In-session stats live on the Session viewer's Stats tab (see SessionStatsView).

export const dynamic = "force-dynamic";

import {
  getStats,
  listSessions,
  getPendingFindingsBySession,
  getFindingKindSessionRefs,
} from "@/lib/read";
import OverviewView from "@/components/OverviewView";
import { parseSessionClassFilter } from "@/lib/session-class";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sessionClass = parseSessionClassFilter(sp.sessionClass);
  const [sessions, stats, pendingFindings, findingKindSessionRefs] = await Promise.all([
    listSessions({ sessionClass }),
    getStats(),
    getPendingFindingsBySession(),
    getFindingKindSessionRefs(),
  ]);
  // session -> primary project, computed from stats so the overview's project
  // scope (the shell TopBar selector → ?project=) scopes a consistent session set
  // (matching the SessionViewer rule).
  const sessionProject: Record<string, string> = {};
  for (const p of stats.projects) for (const r of p.sessionRefs) sessionProject[r.id] = p.project;
  return (
    <OverviewView
      sessions={sessions}
      sessionProject={sessionProject}
      pendingFindings={pendingFindings}
      findingKindSessionRefs={findingKindSessionRefs}
    />
  );
}
