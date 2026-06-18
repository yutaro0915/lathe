"use client";

import type {
  Finding,
  FindingEvidence,
  FindingEvidenceNarrative,
  FindingVerdictValue,
  TurnContextEvent,
} from "@/lib/types";

export type FindingStatusFilter = "pending" | "decided" | "all";

export type ResolvedEvidence =
  | { resolved: true; kind: FindingEvidence["subjectKind"]; label: string; title: string; jump: () => void }
  | { resolved: false; kind: FindingEvidence["subjectKind"]; label: string; title: string };

export const FINDING_KIND_LABEL: Record<Finding["kind"], string> = {
  failure_loop: "failure loop",
  unattributed_diff: "unattributed diff",
  excess_cost: "excess cost",
  risky_action: "risky action",
};

export function findingConfidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function findingVerdictLabel(value: FindingVerdictValue): string {
  return value === "accept" ? "Accepted" : "Rejected";
}

export function shortHash(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

function locatorString(evidence: FindingEvidence, keys: string[]): string | null {
  for (const key of keys) {
    const value = evidence.locator[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function evidenceSessionId(evidence: FindingEvidence): string | null {
  return (
    evidence.sessionId ??
    (evidence.subjectKind === "session" ? evidence.subjectId : null) ??
    locatorString(evidence, ["session_id", "sessionId", "session"])
  );
}

export function findingTouchesSession(finding: Finding, sessionId: string): boolean {
  return finding.evidence.some((evidence) => evidenceSessionId(evidence) === sessionId);
}

export interface EvidenceGroup {
  key: string;
  narrative: FindingEvidenceNarrative | null;
  sessionId: string | null;
  turn: number | null;
  members: FindingEvidence[];
}

export function groupEvidence(evidence: FindingEvidence[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const byKey = new Map<string, EvidenceGroup>();
  for (const item of evidence) {
    const narrative = item.excerpt?.narrative ?? null;
    const sessionId = narrative?.sessionId ?? evidenceSessionId(item);
    const turn = narrative?.turn ?? null;
    const groupable = narrative != null && sessionId != null && turn != null;
    const key = groupable ? `t:${sessionId}::${turn}` : `e:${item.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, narrative, sessionId, turn, members: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.narrative && narrative) group.narrative = narrative;
    group.members.push(item);
  }
  for (const group of groups) {
    group.members.sort((a, b) => {
      const sa = a.excerpt?.seq ?? Number.MAX_SAFE_INTEGER;
      const sb = b.excerpt?.seq ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.id - b.id;
    });
  }
  return groups;
}

const TURN_EVENT_TYPE_LABEL: Record<string, string> = {
  user_message: "user",
  assistant_message: "assistant",
  thinking: "thinking",
  file_read: "read",
  file_edit: "edit",
  file_write: "write",
  bash: "bash",
  subagent: "subagent",
  skill: "skill",
  commit: "commit",
  test: "test",
  error: "error",
  todo: "todo",
  memory: "memory",
  hook: "hook",
};

export function TurnEventRow({
  event,
  onClick,
}: {
  event: TurnContextEvent;
  onClick?: () => void;
}) {
  const isError = event.type === "error" || (event.exitCode != null && event.exitCode !== 0);
  const label = TURN_EVENT_TYPE_LABEL[event.type] ?? event.type;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      role="listitem"
      className={`finding-turn-event${isError ? " err" : ""}${event.isEvidence ? " evidence" : ""}`}
      data-testid="finding-turn-event"
      data-seq={event.seq}
      data-type={event.type}
      data-evidence={event.isEvidence ? "true" : undefined}
      onClick={onClick}
      title={onClick ? "Jump to this step in the transcript" : undefined}
    >
      <span className="finding-turn-event-seq mono" data-testid="finding-turn-event-seq">{event.seq}</span>
      <span className="finding-turn-event-type" data-testid="finding-turn-event-type">{label}</span>
      <span className="finding-turn-event-body" data-testid="finding-turn-event-body">
        {event.command ? (
          <code className="finding-turn-event-cmd mono" data-testid="finding-turn-event-cmd">{event.command}</code>
        ) : (
          <span className="finding-turn-event-text" data-testid="finding-turn-event-text">{event.text ?? event.title}</span>
        )}
      </span>
      {event.exitCode != null && (
        <span className={`finding-turn-event-exit mono ${event.exitCode === 0 ? "ok" : "err"}`} data-testid="finding-turn-event-exit">
          exit {event.exitCode}
        </span>
      )}
    </Tag>
  );
}
