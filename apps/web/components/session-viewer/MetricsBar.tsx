import Link from "next/link";
import CostAnomalyChip from "@/components/CostAnomalyChip";
import { fmtCompact, fmtCost, fmtInt, humanizeDuration, parseStamp } from "@lathe/shared";
import type { PullRequestSummary, Session } from "@/lib/types";

export function MetricsBar({
  primary,
  primaryPrs,
  branch,
  commitLabel,
  currentSessionFindingsCount,
  currentSessionPendingFindingsCount,
  highestTurnJump,
  firstErrorTurnJump,
  openCurrentSessionFindings,
  jumpToTurn,
}: {
  primary: Session;
  primaryPrs: PullRequestSummary[];
  branch: string;
  commitLabel: string;
  currentSessionFindingsCount: number;
  currentSessionPendingFindingsCount: number;
  highestTurnJump: { headerId: string; turn: number; score: number; basis: "cost" | "duration" } | null;
  firstErrorTurnJump: { headerId: string; turn: number; errors: number } | null;
  openCurrentSessionFindings: () => void;
  jumpToTurn: (headerId: string) => void;
}) {
  const sessionDate = parseStamp(primary.startedAt).date;
  return (
    <div className="sessbar" data-testid="sessbar">
      <div className="sessbar-id" data-testid="sessbar-id">
        <span className={`runner-dot ${primary.runner}`} data-testid="runner-dot" aria-hidden />
        <span className="sessbar-title" data-testid="sessbar-title" title={primary.title}>{primary.title}</span>
        {primary.errorCount > 0 && (
          <span className="badge err" data-testid="badge" title={`${primary.errorCount} tool call(s) returned a non-zero exit (incl. sub-agents). Not a session-level verdict.`}>
            {primary.errorCount} error{primary.errorCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="sessbar-meta" data-testid="sessbar-meta">
          {primary.model ?? "—"} · <span className="mono" data-testid="mono">⎇ {branch}</span> · {commitLabel} · {sessionDate} {parseStamp(primary.startedAt).time}
        </span>
        <CostAnomalyChip session={primary} />
        {currentSessionFindingsCount > 0 && (
          <button
            type="button"
            className="chip jump-chip findings-session-chip"
            data-testid="chip"
            data-finding-session-count={currentSessionFindingsCount}
            data-finding-session-pending={currentSessionPendingFindingsCount}
            title="Show findings attached to this session"
            onClick={openCurrentSessionFindings}
          >
            {currentSessionFindingsCount} finding{currentSessionFindingsCount === 1 ? "" : "s"}
            {currentSessionPendingFindingsCount > 0 && <span className="chip-sub mono" data-testid="chip-sub">{currentSessionPendingFindingsCount} pending</span>}
          </button>
        )}
        <span className="sessbar-jumps" data-testid="sessbar-jumps">
          {highestTurnJump && (
            <button
              type="button"
              className="chip jump-chip high-turn-chip"
              data-testid="chip"
              data-jump-kind="highest-cost-turn"
              data-turn={highestTurnJump.turn}
              data-turn-score-basis={highestTurnJump.basis}
              title={highestTurnJump.basis === "cost" ? `Jump to the highest estimated-cost turn (${fmtCost(highestTurnJump.score)})` : `Jump to the longest-duration turn (${humanizeDuration(highestTurnJump.score)})`}
              onClick={() => jumpToTurn(highestTurnJump.headerId)}
            >
              {highestTurnJump.basis === "cost" ? "COSTLIEST TURN" : "LONGEST TURN"}
            </button>
          )}
          {firstErrorTurnJump && (
            <button
              type="button"
              className="chip jump-chip error-turn-chip"
              data-testid="chip"
              data-jump-kind="error-turn"
              data-turn={firstErrorTurnJump.turn}
              title={`Jump to turn ${firstErrorTurnJump.turn} with ${firstErrorTurnJump.errors} error(s)`}
              onClick={() => jumpToTurn(firstErrorTurnJump.headerId)}
            >
              FIRST ERROR TURN
            </button>
          )}
        </span>
        {primaryPrs.length > 0 && (
          <span className="pr-chip-row" data-testid="pr-chip-row">
            {primaryPrs.slice(0, 3).map((pr) => (
              <Link key={pr.id} href={`/pr?pr=${encodeURIComponent(pr.id)}`} className={`pr-chip ${prStateLabel(pr)}`} data-testid="pr-chip" title={pr.title}>
                #{pr.number} {prStateLabel(pr)}
              </Link>
            ))}
          </span>
        )}
      </div>
      <div className="sessbar-stats" data-testid="sessbar-stats">
        <KStat value={humanizeDuration(primary.durationMs)} label="duration" />
        <KStat value={fmtInt(primary.turnCount)} label="turns" />
        <KStat value={fmtInt(primary.toolCount)} label="tools" />
        <KStat value={fmtInt(primary.editCount)} label="edits" />
        <div className="kstat" data-testid="kstat" title={`${fmtInt(primary.tokenIn)} in · ${fmtInt(primary.tokenOut)} out`}>
          <b>{fmtCompact(primary.tokenUsage)}</b>
          <span>tokens</span>
        </div>
        <div className="kstat" data-testid="kstat" title="Estimated cost = real token usage × model pricing (input/output/cache-write/cache-read, per db/pricing.json). Sub-agent tokens not included; '—' when the model isn't priceable.">
          <b>{fmtCost(primary.costUsd)}</b>
          <span>cost</span>
        </div>
      </div>
    </div>
  );
}

function KStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="kstat" data-testid="kstat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function prStateLabel(pr: PullRequestSummary): string {
  if (pr.mergedAt || pr.state === "merged") return "merged";
  return pr.state;
}
