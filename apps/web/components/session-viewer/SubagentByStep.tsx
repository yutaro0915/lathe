import { fmtCost, fmtInt } from "@lathe/shared";
import type { ChangedFile, DiffHunk, Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import { Pressable, RunnerIcon } from "@/design-system/components";
import { NestedMiniSession } from "./NestedMiniSession";
import {
  launcherStats,
  subagentName,
  summarizeInvocation,
  type InvocationSummary,
  type SubagentBlock,
} from "./subagents";

// SubagentByStep — D17 "layout geometry = execution geometry". Launchers are
// grouped into BLOCKS by their launching step (grouping rule in subagents.ts):
//   • PARALLEL block (2+ launchers in the SAME launching step) → a horizontal
//     scroll row of cards (3+ scrolls with a trailing chevron affordance; order
//     carries no priority). Header: `Turn N · step M` + `K parallel`.
//   • SEQUENTIAL block (launchers in different steps/turns) → SEPARATE blocks
//     stacked vertically, time order. Header: `Turn N · step M` + `K`.
// Each card = [runner icon (D4)][name, ellipsized][cost · N tools]. Clicking a
// card expands the nested mini-session (D16) BELOW that card's row (single-select
// across ALL blocks; clicking again / × closes it). No `↓` between turns.

export function SubagentByStep({
  blocks,
  childrenByParent,
  sessionById,
  bundle,
  currentId,
  selectedLauncherId,
  selectLauncher,
  selectedEventId,
  selectEvent,
  flashEventId,
  editByEventId,
  expandedAgents,
  toggleAgent,
  openSubSession,
}: {
  blocks: SubagentBlock[];
  childrenByParent: Map<string, TranscriptEvent[]>;
  sessionById: Map<string, Session>;
  bundle: SessionBundle;
  currentId: string;
  selectedLauncherId: string | null;
  selectLauncher: (launcherId: string) => void;
  selectedEventId?: string;
  selectEvent: (eventId: string) => void;
  flashEventId: string | null;
  editByEventId: Map<string, { file: ChangedFile; hunks: DiffHunk[] }>;
  expandedAgents: Set<string>;
  toggleAgent: (eventId: string) => void;
  openSubSession: (sessionId: string) => void;
}) {
  const summarize = (e: TranscriptEvent): InvocationSummary => summarizeInvocation(e, childrenByParent, sessionById);

  return (
    <div className="lds-sa-bystep" data-testid="sa-bystep">
      {blocks.map((block) => {
        const openInBlock = block.launchers.find((l) => l.id === selectedLauncherId) ?? null;
        return (
          <div className="lds-sa-block" data-testid="sa-block" data-parallel={block.parallel ? "true" : undefined} key={block.key}>
            <div className="lds-sa-block-head" data-testid="sa-block-head">
              <span className="lds-sa-block-where" data-testid="sa-block-where">
                Turn {block.turn} · step {block.stepNo}
              </span>
              <span className="lds-sa-block-count" data-testid="sa-block-count">
                {block.parallel ? `${block.launchers.length} parallel` : `${block.launchers.length}`}
              </span>
            </div>

            {/* parallel → horizontal scroll row; sequential → single card row. */}
            <div
              className={`lds-sa-cards${block.parallel ? " lds-sa-cards-parallel" : ""}`}
              data-testid="sa-cards"
              data-scroll={block.parallel ? "" : undefined}
            >
              {block.launchers.map((launcher) => {
                const summary = summarize(launcher);
                const stats = launcherStats(summary);
                const active = launcher.id === selectedLauncherId;
                const runner = summary.linkedChild?.runner ?? "";
                const name = subagentName(launcher);
                return (
                  <Pressable
                    type="button"
                    key={launcher.id}
                    className={`lds-sa-card${active ? " is-active" : ""}`}
                    data-testid="sa-card"
                    data-launcher-id={launcher.id}
                    aria-expanded={active}
                    onClick={() => selectLauncher(launcher.id)}
                  >
                    <span className="lds-sa-card-top" data-testid="sa-card-top">
                      <RunnerIcon runner={runner} size={16} />
                      <span className="lds-sa-card-name" data-testid="sa-card-name" data-ellipsis-ok title={name}>
                        {name}
                      </span>
                      {stats.runFailed && (
                        <span className="lds-sa-card-err" data-testid="sa-card-err" title="run failed (is_error / non-zero exit)">
                          error
                        </span>
                      )}
                    </span>
                    <span className="lds-sa-card-meta" data-testid="sa-card-meta">
                      {stats.cost != null ? fmtCost(stats.cost) : "—"} · {fmtInt(stats.tools)} tools
                    </span>
                  </Pressable>
                );
              })}
              {block.parallel && block.launchers.length >= 3 && (
                <span className="lds-sa-cards-chev" data-testid="sa-cards-chev" aria-hidden>
                  ›
                </span>
              )}
            </div>

            {/* D16: the selected card's nested mini-session expands BELOW the row. */}
            {openInBlock && (
              <NestedMiniSession
                launcher={openInBlock}
                summary={summarize(openInBlock)}
                bundle={bundle}
                currentId={currentId}
                selectedEventId={selectedEventId}
                selectEvent={selectEvent}
                flashEventId={flashEventId}
                editByEventId={editByEventId}
                childrenByParent={childrenByParent}
                expandedAgents={expandedAgents}
                toggleAgent={toggleAgent}
                openSubSession={openSubSession}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
