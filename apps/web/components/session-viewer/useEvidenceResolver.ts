import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  evidenceSessionId,
  type ResolvedEvidence,
} from "@/components/FindingsExplorer";
import type { FindingEvidence, Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import type { Tab } from "./types";

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

export function useEvidenceResolver({
  bundle,
  currentId,
  sessions,
  eventById,
  eventBySeq,
  turnNumberByEventId,
  setActiveTab,
  selectTimelineEvent,
  jumpToTurn,
  setGitFocusFileId,
  setGitFocusHunkId,
  setGitFocusEvent,
}: {
  bundle: SessionBundle;
  currentId: string;
  sessions: Session[];
  eventById: Map<string, TranscriptEvent>;
  eventBySeq: Map<number, TranscriptEvent>;
  turnNumberByEventId: Map<string, number>;
  setActiveTab: (tab: Tab) => void;
  selectTimelineEvent: (eventId: string, expandTurn?: boolean) => void;
  jumpToTurn: (headerId: string) => void;
  setGitFocusFileId: (id: string | undefined) => void;
  setGitFocusHunkId: (id: string | undefined) => void;
  setGitFocusEvent: (id: string | undefined) => void;
}) {
  const router = useRouter();
  const hunkTargetById = useMemo(() => {
    const map = new Map<string, { fileId: string; hunkId: string; hunkSeq: number; path: string }>();
    for (const file of bundle.changedFiles) {
      for (const hunk of bundle.hunks[file.id] ?? []) {
        map.set(hunk.id, { fileId: file.id, hunkId: hunk.id, hunkSeq: hunk.seq, path: file.path });
      }
    }
    return map;
  }, [bundle.changedFiles, bundle.hunks]);

  return (evidence: FindingEvidence): ResolvedEvidence => {
    const targetSessionId = evidenceSessionId(evidence);
    const sameSession = !targetSessionId || targetSessionId === currentId;

    if (evidence.subjectKind === "session") {
      if (!targetSessionId || sessions.some((session) => session.id === targetSessionId)) {
        return {
          resolved: true,
          kind: "session",
          label: targetSessionId === currentId || !targetSessionId ? "session" : "session ↗",
          title: targetSessionId ?? currentId,
          jump: () => {
            if (targetSessionId && targetSessionId !== currentId) {
              router.push(`/?session=${encodeURIComponent(targetSessionId)}&tab=transcript`);
              return;
            }
            setActiveTab("transcript");
          },
        };
      }
    }

    if (evidence.subjectKind === "event" || evidence.subjectKind === "turn") {
      const eventId = evidence.subjectId ?? locatorString(evidence, ["event_id", "eventId"]);
      const seq = locatorNumber(evidence, ["seq", "at_seq", "step"]);
      const target = sameSession
        ? (eventId ? eventById.get(eventId) : undefined) ?? (seq != null ? eventBySeq.get(seq) : undefined)
        : undefined;
      if (target) {
        return {
          resolved: true,
          kind: evidence.subjectKind,
          label: `step ${target.seq}`,
          title: target.title,
          jump: () => {
            setActiveTab("transcript");
            selectTimelineEvent(target.id, true);
          },
        };
      }
      if (evidence.subjectKind === "turn") {
        const turn = locatorNumber(evidence, ["turn", "turn_number", "turnNumber"]);
        const headerId = turn == null ? null : [...turnNumberByEventId.entries()].find(([, value]) => value === turn)?.[0] ?? null;
        if (sameSession && headerId) {
          return { resolved: true, kind: "turn", label: `turn ${turn}`, title: `Turn ${turn}`, jump: () => jumpToTurn(headerId) };
        }
      }
      if (targetSessionId && targetSessionId !== currentId) {
        const seqParam = seq != null ? `&seq=${seq}` : "";
        return {
          resolved: true,
          kind: evidence.subjectKind,
          label: seq != null ? `step ${seq} ↗` : "step ↗",
          title: targetSessionId,
          jump: () => router.push(`/?session=${encodeURIComponent(targetSessionId)}&tab=transcript${seqParam}`),
        };
      }
    }

    if (evidence.subjectKind === "hunk") {
      const hunkId = evidence.subjectId ?? locatorString(evidence, ["hunk_id", "hunkId"]);
      const path = locatorString(evidence, ["path", "file_path", "filePath"]);
      const hunkSeq = locatorNumber(evidence, ["hunk_seq", "hunkSeq", "seq"]);
      let target = hunkId ? hunkTargetById.get(hunkId) : undefined;
      if (!target && path && hunkSeq != null) {
        for (const file of bundle.changedFiles) {
          if (file.path !== path) continue;
          const hunk = (bundle.hunks[file.id] ?? []).find((item) => item.seq === hunkSeq);
          if (hunk) {
            target = { fileId: file.id, hunkId: hunk.id, hunkSeq: hunk.seq, path: file.path };
            break;
          }
        }
      }
      if (sameSession && target) {
        return {
          resolved: true,
          kind: "hunk",
          label: `hunk ${target.hunkSeq}`,
          title: target.path,
          jump: () => {
            setGitFocusFileId(target.fileId);
            setGitFocusHunkId(target.hunkId);
            setGitFocusEvent(undefined);
            setActiveTab("git");
          },
        };
      }
      if (targetSessionId && targetSessionId !== currentId) {
        return {
          resolved: true,
          kind: "hunk",
          label: hunkSeq != null ? `hunk ${hunkSeq} ↗` : "hunk ↗",
          title: targetSessionId,
          jump: () => router.push(`/?session=${encodeURIComponent(targetSessionId)}&tab=git`),
        };
      }
    }

    if (evidence.subjectKind === "pr") {
      const prId = evidence.subjectId ?? locatorString(evidence, ["pr_id", "prId"]);
      const prNumber = locatorNumber(evidence, ["number", "pr_number", "prNumber"]);
      const pr = prId
        ? bundle.pullRequests.find((item) => item.id === prId)
        : prNumber != null
          ? bundle.pullRequests.find((item) => item.number === prNumber)
          : undefined;
      const targetPrId = prId ?? pr?.id;
      if (targetPrId) {
        return {
          resolved: true,
          kind: "pr",
          label: pr ? `PR #${pr.number}` : "PR ↗",
          title: pr?.title ?? targetPrId,
          jump: () => router.push(`/pr?pr=${encodeURIComponent(targetPrId)}`),
        };
      }
    }

    return {
      resolved: false,
      kind: evidence.subjectKind,
      label: "unresolved",
      title: evidence.note ?? "This evidence cannot be resolved against the current data",
    };
  };
}
