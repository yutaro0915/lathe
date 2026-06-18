import { fmtCost, fmtInt, shortModel } from "@lathe/shared";
import type { TranscriptEvent } from "@/lib/types";
import { SimpleEventRow } from "./SimpleEventRow";
import { durLabel } from "./types";
import { invocationSummaryLine, type InvocationSummary } from "./subagents";

function fmtDur2(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function SubagentDetail({
  invocation,
  summary,
  selectedEventId,
  setSelectedEventId,
  copied,
  copy,
  openSubSession,
}: {
  invocation: TranscriptEvent;
  summary: InvocationSummary;
  selectedEventId?: string;
  setSelectedEventId: (eventId: string) => void;
  copied: string | null;
  copy: (key: string, text: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  const { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools, linkedChild } = summary;
  const displaySteps = linkedChild ? linkedChild.stepCount : kids.length;
  const displayTools = linkedChild ? linkedChild.toolCount : (toolUses ?? observedTools);
  const displayModel = linkedChild?.model ?? model ?? null;
  const displayDuration = linkedChild?.durationMs ?? invocation.durationMs;
  const tokensShown = linkedChild ? linkedChild.tokenUsage : (invocation.tokenUsage ?? tokens ?? null);
  const displayCost = linkedChild ? linkedChild.costUsd : costUsd;

  return (
    <div className="sa-detail" data-testid="sa-detail">
      <div className="sa-detail-stats" data-testid="sa-detail-stats">
        <Stat label="Steps">
          {displaySteps}
          {failedSteps > 0 && (
            <span className="stat-note failed-steps-note" data-testid="stat-note" title={`${failedSteps} child step(s) exited non-zero — distinct from the run's own result`}>
              {failedSteps} failed
            </span>
          )}
        </Stat>
        <Stat label="Tool calls">
          {linkedChild || toolUses != null ? (
            <span className="stat-v" data-testid="stat-v">{displayTools}</span>
          ) : (
            <span className="stat-v" data-testid="stat-v" title="not reported by the run; counted from observed tool steps in the transcript">
              {displayTools}
            </span>
          )}
        </Stat>
        <Stat label="Model" valueClass="" valueStyle={{ fontSize: "12.5px" }} title={displayModel ?? "not recorded in the transcript"}>
          {displayModel ? shortModel(displayModel) : "—"}
        </Stat>
        <Stat label="Duration" title={displayDuration == null ? "not recorded in the transcript" : undefined}>
          {displayDuration != null ? fmtDur2(displayDuration) : "—"}
        </Stat>
        <Stat label="Tokens" title={invocation.tokenUsage != null ? undefined : tokensShown != null ? "summed from the sub-agent's own transcript (cache reads excluded) — the same usage its cost is priced from" : "no usage recorded in either transcript"}>
          {tokensShown != null ? fmtInt(tokensShown) : "—"}
        </Stat>
        <Stat label="Cost" title={displayCost == null ? "model or token usage not recorded — cost is not invented" : undefined}>
          {displayCost != null ? fmtCost(displayCost) : "—"}
        </Stat>
        <Stat label="Result" valueClass={runFailed ? "err" : "ok"} title="The run's own verdict (the launcher's is_error / exit). Child-step failures are reported separately under Steps.">
          {runFailed ? "error" : "ok"}
        </Stat>
      </div>

      {invocation.body && (
        <div className="sa-detail-summary" data-testid="sa-detail-summary">
          <div className="io-head" data-testid="io-head">
            <span>Result · summary</span>
            <button type="button" className="io-copy" data-testid="io-copy" onClick={() => copy(`sa-${invocation.id}`, invocation.body ?? "")}>
              {copied === `sa-${invocation.id}` ? "✓ copied" : "⧉ copy"}
            </button>
          </div>
          <div
            className="sa-summary-body"
            data-testid="sa-summary-body"
            onClick={() => setSelectedEventId(invocation.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                setSelectedEventId(invocation.id);
              }
            }}
          >
            {invocationSummaryLine(invocation)}
          </div>
        </div>
      )}

      <div className="panel-title" data-testid="panel-title" style={{ padding: "10px 14px 0" }}>
        Execution <span className="count" data-testid="count">({displaySteps} steps)</span>
      </div>
      {linkedChild ? (
        <div className="sa-linked-session" data-testid="sa-linked-session" style={{ margin: "8px 14px 14px" }}>
          <div className="sa-linked-title" data-testid="sa-linked-title">{linkedChild.title}</div>
          <div className="muted small" data-testid="muted">Open the linked sub-session to inspect its captured transcript.</div>
          <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => openSubSession(linkedChild.id)}>
            OPEN SUB-SESSION →
          </button>
        </div>
      ) : kids.length === 0 ? (
        <div className="empty" data-testid="empty" style={{ padding: "8px 16px 16px" }}>
          internal steps not captured
        </div>
      ) : (
        kids.map((k) => (
          <SimpleEventRow key={k.id} event={k} child selected={selectedEventId === k.id} onSelect={setSelectedEventId} />
        ))
      )}
    </div>
  );
}

function Stat({
  label,
  children,
  valueClass,
  valueStyle,
  title,
}: {
  label: string;
  children: React.ReactNode;
  valueClass?: string;
  valueStyle?: React.CSSProperties;
  title?: string;
}) {
  if (label === "Tool calls" && typeof children !== "string") {
    return (
      <div className="stat" data-testid="stat">
        <span className="stat-k" data-testid="stat-k">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div className="stat" data-testid="stat">
      <span className="stat-k" data-testid="stat-k">{label}</span>
      <span className={`stat-v${valueClass ? ` ${valueClass}` : ""}`} data-testid="stat-v" style={valueStyle} title={title}>
        {children}
      </span>
    </div>
  );
}
