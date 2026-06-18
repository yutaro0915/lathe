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
