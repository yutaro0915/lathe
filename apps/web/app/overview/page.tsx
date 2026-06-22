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
  getFindingKindCounts,
} from "@/lib/read";
import OverviewView from "@/components/OverviewView";

export default async function Page() {
  const [sessions, stats, pendingFindings, findingKindCounts] = await Promise.all([
    listSessions(),
    getStats(),
    getPendingFindingsBySession(),
    getFindingKindCounts(),
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
      findingKindCounts={findingKindCounts}
    />
  );
}
