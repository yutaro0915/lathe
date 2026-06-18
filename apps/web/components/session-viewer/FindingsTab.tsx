import FindingsExplorer, { type ResolvedEvidence } from "@/components/FindingsExplorer";
import type { Dispatch, SetStateAction } from "react";
import type { Finding, FindingEvidence, Session } from "@/lib/types";

export function FindingsTab({
  findings,
  setFindings,
  sessions,
  currentId,
  resolveEvidence,
  onJumpToSession,
  onJumpToTurn,
}: {
  findings: Finding[];
  setFindings: Dispatch<SetStateAction<Finding[]>>;
  sessions: Session[];
  currentId: string;
  resolveEvidence: (evidence: FindingEvidence) => ResolvedEvidence;
  onJumpToSession: (sessionId: string, findingId?: number) => void;
  onJumpToTurn: (sessionId: string, turn: number, headSeq: number | null, findingId?: number) => void;
}) {
  return (
    <FindingsExplorer
      findings={findings}
      setFindings={setFindings}
      sessions={sessions}
      mode="session"
      scopeSessionId={currentId}
      resolveEvidence={resolveEvidence}
      initialStatusFilter="pending"
      onJumpToSession={onJumpToSession}
      onJumpToTurn={onJumpToTurn}
    />
  );
}
