"use client";

// components/FindingsAxisView.tsx — the cross-session Findings AXIS (route
// /findings). The global bar's "Findings" lands here.
//
// This is the cross-cutting home for findings: every finding across every
// session, with Pending/Decided/All + a session filter. Because no single
// session bundle is loaded here, evidence "jump" always deep-links into the
// owning session's Sessions-axis screen (/?session=…&tab=transcript&seq=…),
// where the transcript scrolls to and flashes the step. That is the SAME
// Sessions screen in a different state — never a separate screen.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Surface } from "@/design-system/components";
import FindingsExplorer, {
  evidenceSessionId,
  type ResolvedEvidence,
} from "@/components/FindingsExplorer";
import type { Finding, FindingEvidence, Session } from "@/lib/types";

function locatorString(evidence: FindingEvidence, keys: string[]): string | null {
  for (const key of keys) {
    const value = evidence.locator[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function locatorNumber(evidence: FindingEvidence, keys: string[]): number | null {
  for (const key of keys) {
    const value = evidence.locator[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export default function FindingsAxisView({
  findings: initialFindings,
  sessions,
  initialSessionFilter,
}: {
  findings: Finding[];
  sessions: Session[];
  initialSessionFilter?: string;
}) {
  const router = useRouter();
  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // On the axis, every evidence target is a deep link into the owning session's
  // transcript (the Sessions axis). We can resolve a label from the locator, but
  // the in-page anchors (event id / hunk) don't exist here, so the jump is a
  // router.push that the destination screen interprets.
  function resolveEvidence(evidence: FindingEvidence): ResolvedEvidence {
    const sessionId = evidenceSessionId(evidence);
    const seq = locatorNumber(evidence, ["seq", "at_seq", "step"]);
    const known = sessionId ? sessionById.has(sessionId) : false;

    if (evidence.subjectKind === "pr") {
      const prId = evidence.subjectId ?? locatorString(evidence, ["pr_id", "prId"]);
      const prNumber = locatorNumber(evidence, ["number", "pr_number", "prNumber"]);
      if (prId) {
        return {
          resolved: true,
          kind: "pr",
          label: prNumber != null ? `PR #${prNumber} ↗` : "PR ↗",
          title: prId,
          jump: () => router.push(`/pr?pr=${encodeURIComponent(prId)}`),
        };
      }
    }

    if (sessionId && known) {
      const tab = evidence.subjectKind === "hunk" ? "git" : "transcript";
      const seqParam = seq != null && tab === "transcript" ? `&seq=${seq}` : "";
      const label =
        evidence.subjectKind === "session"
          ? "session ↗"
          : evidence.subjectKind === "hunk"
            ? "hunk ↗"
            : seq != null
              ? `step ${seq} ↗`
              : "step ↗";
      return {
        resolved: true,
        kind: evidence.subjectKind,
        label,
        title: sessionById.get(sessionId)?.title ?? sessionId,
        jump: () =>
          router.push(`/?session=${encodeURIComponent(sessionId)}&tab=${tab}${seqParam}`),
      };
    }

    return {
      resolved: false,
      kind: evidence.subjectKind,
      label: "unresolved",
      title: evidence.note ?? "This evidence cannot be resolved against the current data",
    };
  }

  // The cross-session axis description (left of the WorkareaHeader, as `meta`).
  // The Pending/Decided/All filter + the session select are FindingsExplorer's
  // own toolbar (it is the same master-detail component the in-session tab uses,
  // and the e2e contract reads findings-filter / findings-session-select there) —
  // they ride at the top of the Surface body, not duplicated into the header.
  const meta = "All findings across every session — the cross-session axis. Pick a session to scope.";

  return (
    // The Findings axis no longer draws its own .lds-session-bar band: the
    // shell-owned Surface WorkareaHeader carries the title + meta (and the
    // `sessbar` testid via headerTestId), so the master-detail body starts flush
    // under one uniform header — no self-drawn header step (Layout v2, slice 4).
    <Surface
      surface="findings"
      headerTestId="sessbar"
      title={<span data-testid="sessbar-title">Findings</span>}
      meta={<span data-testid="sessbar-meta">{meta}</span>}
    >
      <div className="findings-axis-main" data-testid="main" data-tab="findings">
        <FindingsExplorer
          findings={findings}
          setFindings={setFindings}
          sessions={sessions}
          mode="axis"
          resolveEvidence={resolveEvidence}
          initialStatusFilter="pending"
          initialSessionFilter={initialSessionFilter}
          // SESSION / TURN header jumps deep-link into the owning session's
          // transcript — the SAME Sessions axis in a different state. `from`
          // carries the originating finding id so the destination transcript
          // shows a "from finding #N" landing banner (requirement D).
          onJumpToSession={(sessionId, findingId) =>
            router.push(
              `/?session=${encodeURIComponent(sessionId)}&tab=transcript${
                findingId != null ? `&fromFinding=${findingId}` : ""
              }`,
            )
          }
          onJumpToTurn={(sessionId, _turn, headSeq, findingId) =>
            router.push(
              `/?session=${encodeURIComponent(sessionId)}&tab=transcript${
                headSeq != null ? `&seq=${headSeq}` : ""
              }${findingId != null ? `&fromFinding=${findingId}` : ""}`,
            )
          }
        />
      </div>
    </Surface>
  );
}
