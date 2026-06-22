import type { Session, TranscriptEvent } from "@/lib/types";

export type InvocationSummary = {
  kids: TranscriptEvent[];
  toolUses: number | undefined;
  runFailed: boolean;
  failedSteps: number;
  model: string | undefined;
  costUsd: number | undefined;
  tokens: number | undefined;
  observedTools: number;
  linkedChild: Session | undefined;
};

export function summarizeInvocation(
  launcher: TranscriptEvent,
  childrenByParent: Map<string, TranscriptEvent[]>,
  sessionById: Map<string, Session>,
): InvocationSummary {
  const kids = childrenByParent.get(launcher.id) ?? [];
  let toolUses: number | undefined;
  let model: string | undefined;
  let costUsd: number | undefined;
  let tokens: number | undefined;
  let agentId: string | undefined;
  let childSessionId: string | undefined;
  try {
    const m = launcher.meta ? JSON.parse(launcher.meta) : {};
    if (typeof m.toolUses === "number") toolUses = m.toolUses;
    if (typeof m.model === "string") model = m.model;
    if (typeof m.costUsd === "number") costUsd = m.costUsd;
    if (typeof m.tokens === "number") tokens = m.tokens;
    if (typeof m.agent_id === "string") agentId = m.agent_id;
    if (typeof m.child_session_id === "string") childSessionId = m.child_session_id;
  } catch {
    /* ignore */
  }
  const linkedChild = childSessionId ? sessionById.get(childSessionId) : agentId ? sessionById.get(agentId) : undefined;
  let metaIsError: boolean | undefined;
  try {
    const m = launcher.meta ? JSON.parse(launcher.meta) : {};
    if (typeof m.isError === "boolean") metaIsError = m.isError;
  } catch {
    /* ignore */
  }
  const runFailed = metaIsError ?? (launcher.exitCode != null ? launcher.exitCode !== 0 : false);
  const failedSteps = kids.filter((k) => k.exitCode != null && k.exitCode !== 0).length;
  const observedTools = kids.filter((k) => !["user_message", "assistant_message", "thinking"].includes(k.type)).length;
  return { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools, linkedChild };
}

export function invocationSummaryLine(e: TranscriptEvent): string {
  const body = (e.body ?? "").trim();
  if (body) return body.split("\n").find((l) => l.trim()) ?? e.title;
  return e.title;
}

// The compact card stat-line numbers (D18 card: `cost · N tools`). The displayed
// tool count + cost prefer the linked child's resolved facts, falling back to the
// launcher meta / observed kids — the same precedence the old detail used, kept in
// one place so the card and the nested header agree.
export type LauncherStats = {
  cost: number | undefined;
  tools: number;
  steps: number;
  runFailed: boolean;
  failedSteps: number;
};

export function launcherStats(s: InvocationSummary): LauncherStats {
  const { kids, toolUses, runFailed, failedSteps, costUsd, observedTools, linkedChild } = s;
  return {
    cost: linkedChild ? linkedChild.costUsd ?? undefined : costUsd,
    tools: linkedChild ? linkedChild.toolCount : toolUses ?? observedTools,
    steps: linkedChild ? linkedChild.stepCount : kids.length,
    runFailed,
    failedSteps,
  };
}

// The short sub-agent name shown on the card / nested header (ellipsized in CSS).
export function subagentName(e: TranscriptEvent): string {
  return e.subagent ?? "sub-agent";
}

// ---- D17 execution geometry: group launchers by their LAUNCHING STEP ---------
// A "launching step" = (turn, the contiguous run of consecutive subagent
// launchers fired within that turn). Two launchers belong to the SAME launching
// step (= a PARALLEL fan-out) when they are in the SAME turn AND are CONTIGUOUS
// in the top-level event stream (no non-subagent top-level step sits between
// them). Launchers in a DIFFERENT turn, or separated by an intervening
// non-subagent step, start a NEW (SEQUENTIAL) block. This is best-effort and
// deliberately conservative: it never merges launches that have other work
// between them (which would be obviously sequential) into one parallel block.
//
// Inputs:
//   topEvents              — all top-level (parentId == null) events, seq order.
//   turnNumberByEventId    — 1-based turn per top event (from useTurnRollups wiring).
//   turnHeaderIds          — top event id → its turn-header (user_message) id.
// The `stepNo` is the launcher's 1-based position among the NON-header top events
// inside its turn — the same step numbering the transcript uses, so a block
// header reads `Turn N · step M` consistently with the Transcript tab (D17 propagate).

export type SubagentBlock = {
  key: string; // stable: first launcher id in the block
  turn: number;
  stepNo: number; // 1-based step index of the FIRST launcher within its turn
  parallel: boolean; // 2+ launchers in the same launching step → horizontal row
  launchers: TranscriptEvent[];
};

export function groupLaunchersByStep(
  invocations: TranscriptEvent[],
  topEvents: TranscriptEvent[],
  turnNumberByEventId: Map<string, number>,
  turnHeaderIds: Map<string, string>,
): SubagentBlock[] {
  if (invocations.length === 0) return [];

  // step number within turn: walk top events, counting non-header steps per turn.
  const stepNoByEventId = new Map<string, number>();
  const stepCountByTurnHeader = new Map<string, number>();
  for (const e of topEvents) {
    const headerId = turnHeaderIds.get(e.id);
    if (!headerId) continue;
    if (e.id === headerId) continue; // the header itself is not a step
    const n = (stepCountByTurnHeader.get(headerId) ?? 0) + 1;
    stepCountByTurnHeader.set(headerId, n);
    stepNoByEventId.set(e.id, n);
  }

  const turnOf = (e: TranscriptEvent): number => {
    const headerId = turnHeaderIds.get(e.id);
    return (headerId ? turnNumberByEventId.get(headerId) : turnNumberByEventId.get(e.id)) ?? 0;
  };

  // index of each top event so we can test contiguity in the stream.
  const topIndexById = new Map<string, number>();
  topEvents.forEach((e, i) => topIndexById.set(e.id, i));
  const isLauncher = new Set(invocations.map((i) => i.id));

  // launchers in stream order (invocations are already filtered top-level; sort
  // by their position in topEvents to be safe).
  const ordered = [...invocations].sort(
    (a, b) => (topIndexById.get(a.id) ?? a.seq) - (topIndexById.get(b.id) ?? b.seq),
  );

  const blocks: SubagentBlock[] = [];
  let current: TranscriptEvent[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    blocks.push({
      key: first.id,
      turn: turnOf(first),
      stepNo: stepNoByEventId.get(first.id) ?? 0,
      parallel: current.length > 1,
      launchers: current,
    });
    current = [];
  };

  for (const launcher of ordered) {
    if (current.length === 0) {
      current.push(launcher);
      continue;
    }
    const prev = current[current.length - 1];
    const sameTurn = turnOf(prev) === turnOf(launcher);
    // contiguous = nothing between prev and launcher in the top stream is a
    // non-subagent step (only other launchers may sit between, e.g. a fan-out).
    const pi = topIndexById.get(prev.id) ?? -1;
    const li = topIndexById.get(launcher.id) ?? -1;
    let contiguous = pi >= 0 && li > pi;
    if (contiguous) {
      for (let j = pi + 1; j < li; j += 1) {
        const between = topEvents[j];
        if (!isLauncher.has(between.id)) {
          contiguous = false;
          break;
        }
      }
    }
    if (sameTurn && contiguous) {
      current.push(launcher);
    } else {
      flush();
      current.push(launcher);
    }
  }
  flush();
  return blocks;
}
