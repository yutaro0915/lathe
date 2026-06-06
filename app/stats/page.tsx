// app/stats/page.tsx — cross-session statistics (per-project + usage).
//
// Thin SERVER wrapper: computes the StatsBundle from the db (read-only) and
// hands it to the interactive client component. The client never touches the db.
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import { getStats, listSessions } from "@/lib/db";
import StatsView from "@/components/StatsView";

export default async function Page() {
  const stats = getStats();
  const sessions = listSessions();
  return <StatsView stats={stats} sessions={sessions} />;
}
