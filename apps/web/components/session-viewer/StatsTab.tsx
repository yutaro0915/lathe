import SessionStatsView from "@/components/SessionStatsView";
import type { SessionBundle } from "@/lib/types";

export function StatsTab({ bundle }: { bundle: SessionBundle }) {
  return <SessionStatsView bundle={bundle} />;
}
