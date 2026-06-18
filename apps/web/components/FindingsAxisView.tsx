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

  return (
    <div className="findings-axis-page" data-testid="findings-axis-page">
      {/* sessbar-like header so the chrome matches the Sessions / Overview axes */}
      <div className="sessbar" data-testid="sessbar">
        <div className="sessbar-id" data-testid="sessbar-id">
          <span className="sessbar-title" data-testid="sessbar-title">Findings</span>
          <span className="sessbar-meta" data-testid="sessbar-meta">
            All findings across every session — the cross-session axis. Pick a session to scope.
          </span>
        </div>
      </div>

      <div
        className="layout3 findings-axis-shell" data-testid="layout3"
        data-tab="findings"
        style={{ gridTemplateColumns: "minmax(0,1fr)" }}
      >
        <main className="main findings-axis-main" data-testid="main">
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
        </main>
      </div>
    </div>
  );
}
