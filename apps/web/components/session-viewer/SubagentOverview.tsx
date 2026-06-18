import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import { fmtCost, fmtTok, shortModel } from "@lathe/shared";
import type { TranscriptEvent } from "@/lib/types";
import { durLabel } from "./types";
import { invocationSummaryLine, type InvocationSummary } from "./subagents";

export function SubagentOverview({
  invocations,
  summarize,
  openAgent,
  openSubSession,
}: {
  invocations: TranscriptEvent[];
  summarize: (event: TranscriptEvent) => InvocationSummary;
  openAgent: (launcherId: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  return (
    <>
      {invocations.map((e, i) => {
        const { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools, linkedChild } = summarize(e);
        const displaySteps = linkedChild ? linkedChild.stepCount : kids.length;
        const displayTools = linkedChild ? linkedChild.toolCount : (toolUses ?? observedTools);
        const displayModel = linkedChild?.model ?? model;
        const displayDuration = linkedChild?.durationMs ?? e.durationMs;
        const displayTokens = linkedChild ? linkedChild.tokenUsage : (e.tokenUsage ?? tokens ?? null);
        const displayCost = linkedChild ? linkedChild.costUsd : costUsd;
        const unlinkedNoSteps = !linkedChild && kids.length === 0;
        return (
          <button key={e.id} type="button" className="sa-card" data-testid="sa-card" onClick={() => (linkedChild ? openSubSession(linkedChild.id) : openAgent(e.id))}>
            <span className="sa-card-idx" data-testid="sa-card-idx">{i + 1}</span>
            <div className="sa-card-main" data-testid="sa-card-main">
              <div className="sa-card-top" data-testid="sa-card-top">
                <span className="event-type-badge subagent" data-testid="event-type-badge">⌥ {e.subagent ?? "sub-agent"}</span>
                {displayModel && <span className="sa-model" data-testid="sa-model" title="model the sub-agent ran on">{shortModel(displayModel)}</span>}
                <span className="sa-card-time" data-testid="sa-card-time">{e.ts}</span>
                {runFailed && <span className="badge failed" data-testid="badge">error</span>}
                {linkedChild && <span className="badge neutral" data-testid="badge">linked</span>}
                {failedSteps > 0 && (
                  <span className="chip failed-steps-chip" data-testid="chip" title={`${failedSteps} child step(s) exited non-zero — distinct from the run's own result`}>
                    {failedSteps} failed step{failedSteps === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <div className="sa-card-task" data-testid="sa-card-task">{invocationSummaryLine(e)}</div>
              {kids.length > 0 && (
                <div className="sa-card-steps" data-testid="sa-card-steps" aria-hidden>
                  {kids.slice(0, 16).map((k) => (
                    <span key={k.id} className={`sa-glyph ${k.type}`} data-testid="sa-glyph" title={`${EVENT_LABEL[k.type]} · ${k.title}`}>
                      {TYPE_GLYPH[k.type] ?? "•"}
                    </span>
                  ))}
                  {kids.length > 16 && <span className="sa-more" data-testid="sa-more">+{kids.length - 16}</span>}
                </div>
              )}
            </div>
            <span className="sa-card-meta" data-testid="sa-card-meta">
              {unlinkedNoSteps ? (
                <span className="sa-capture-note" data-testid="sa-capture-note">internal steps not captured</span>
              ) : (
                <>
                  <span className="chip" data-testid="chip">{displaySteps} steps</span>
                  <span className="chip" data-testid="chip">{displayTools} tools</span>
                  {displayDuration != null && <span className="dur" data-testid="dur">{durLabel(displayDuration)}</span>}
                  {displayTokens != null && <span className="tok" data-testid="tok">{fmtTok(displayTokens)} tok</span>}
                  {displayCost != null && <span className="sa-cost" data-testid="sa-cost">{fmtCost(displayCost)}</span>}
                </>
              )}
              <span className="sa-go" data-testid="sa-go">{linkedChild ? "OPEN SUB-SESSION →" : "Open →"}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
