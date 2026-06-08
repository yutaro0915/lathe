// app/overview/page.tsx — Home / project-level analytics screen.
//
// The cross-session "where did the work go?" view: per-scope cost & tokens over
// time, model breakdown, event composition, biggest sessions. This is the right
// place for project-/all-projects-level stats — picking a single session
// shouldn't surface aggregates over every other session.
//
// In-session stats live on the Session viewer's Stats tab (see SessionStatsView).
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import { getStats, listSessions, getSessionEventCounts } from "@/lib/db";
import OverviewView from "@/components/OverviewView";

export default function Page() {
  const sessions = listSessions();
  const stats = getStats();
  const eventCounts = getSessionEventCounts();
  // session -> primary project, computed from stats so the overview's project
  // selector scopes a consistent session set (matching the SessionViewer rule).
  const sessionProject: Record<string, string> = {};
  for (const p of stats.projects) for (const r of p.sessionRefs) sessionProject[r.id] = p.project;
  return (
    <OverviewView
      sessions={sessions}
      stats={stats}
      eventCounts={eventCounts}
      sessionProject={sessionProject}
    />
  );
}
