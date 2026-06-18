import type { Session, TranscriptEvent } from "@/lib/types";
import { SubagentDetail } from "./SubagentDetail";
import { SubagentOverview } from "./SubagentOverview";
import { summarizeInvocation, type InvocationSummary } from "./subagents";

export function SubagentsTab({
  invocations,
  subAgentTab,
  setSubAgentTab,
  childrenByParent,
  sessionById,
  selectedEventId,
  setSelectedEventId,
  copied,
  copy,
  openAgent,
  openSubSession,
}: {
  invocations: TranscriptEvent[];
  subAgentTab: string;
  setSubAgentTab: (tab: string) => void;
  childrenByParent: Map<string, TranscriptEvent[]>;
  sessionById: Map<string, Session>;
  selectedEventId?: string;
  setSelectedEventId: (eventId: string) => void;
  copied: string | null;
  copy: (key: string, text: string) => void;
  openAgent: (launcherId: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  const summarize = (event: TranscriptEvent): InvocationSummary => summarizeInvocation(event, childrenByParent, sessionById);

  return (
    <div className="sa-wrap" data-testid="sa-wrap">
      {invocations.length === 0 ? (
        <div className="timeline" data-testid="timeline">
          <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
            No sub-agent runs in this session.
          </div>
        </div>
      ) : (
        <>
          <div className="sa-tabbar" data-testid="sa-tabbar" role="tablist" aria-label="Sub-agent runs">
            <button
              type="button"
              role="tab"
              aria-selected={subAgentTab === "overview"}
              className={`sa-tab${subAgentTab === "overview" ? " active" : ""}`}
              data-testid="sa-tab"
              onClick={() => setSubAgentTab("overview")}
            >
              ◇ Overview
              <span className="sa-tab-count" data-testid="sa-tab-count">{invocations.length}</span>
            </button>
            {invocations.map((inv, i) => {
              const on = subAgentTab === inv.id;
              const label = inv.subagent ?? "sub-agent";
              return (
                <button
                  key={inv.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`sa-tab${on ? " active" : ""}`}
                  data-testid="sa-tab"
                  onClick={() => openAgent(inv.id)}
                  title={`Agent ${i + 1} · ${label}`}
                >
                  <span className="sa-tab-idx" data-testid="sa-tab-idx">{i + 1}</span>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="timeline" data-testid="timeline">
            {subAgentTab === "overview" ? (
              <SubagentOverview invocations={invocations} summarize={summarize} openAgent={openAgent} openSubSession={openSubSession} />
            ) : (
              (() => {
                const invocation = invocations.find((x) => x.id === subAgentTab);
                if (!invocation) return null;
                return (
                  <SubagentDetail
                    invocation={invocation}
                    summary={summarize(invocation)}
                    selectedEventId={selectedEventId}
                    setSelectedEventId={setSelectedEventId}
                    copied={copied}
                    copy={copy}
                    openSubSession={openSubSession}
                  />
                );
              })()
            )}
          </div>
        </>
      )}
    </div>
  );
}
