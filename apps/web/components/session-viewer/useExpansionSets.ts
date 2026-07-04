import { useEffect, useState } from "react";
import { addToSet, toggleInSet } from "./expand-set";

// useExpansionSets — all expansion/collapse state for agents, events, tool types,
// skills, turns, and the subagent launcher selection. Extracted from SessionViewer
// (file-size I4).
export function useExpansionSets({
  primaryId,
  turnNumberByEventId,
  turnHeaderIds,
}: {
  primaryId: string;
  turnNumberByEventId: Map<string, number>;
  turnHeaderIds: Map<string, string>;
}) {
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [expandedToolTypes, setExpandedToolTypes] = useState<Set<string>>(() => new Set());
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());
  const [selectedLauncherId, setSelectedLauncherId] = useState<string | null>(null);

  // Reset expansion/selection on session change.
  useEffect(() => {
    setSelectedLauncherId(null);
    setExpandedEventIds(new Set());
    setExpandedToolTypes(new Set());
    setExpandedSkills(new Set());
  }, [primaryId]);

  // Collapse all turns when session or turn map changes.
  useEffect(() => {
    setCollapsedTurns(new Set(turnNumberByEventId.keys()));
  }, [primaryId, turnNumberByEventId]);

  function expandEvent(eventId: string, mode: "open" | "toggle" = "open") {
    setExpandedEventIds((prev) =>
      mode === "toggle" ? toggleInSet(prev, eventId) : addToSet(prev, eventId),
    );
  }

  function expandTurnForEvent(eventId: string) {
    const headerId = turnHeaderIds.get(eventId);
    if (!headerId) return;
    setCollapsedTurns((prev) => {
      if (!prev.has(headerId)) return prev;
      const next = new Set(prev);
      next.delete(headerId);
      return next;
    });
  }

  function toggleTurn(headerId: string) {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(headerId)) next.delete(headerId);
      else next.add(headerId);
      return next;
    });
  }

  function toggleAgent(eventId: string) {
    setExpandedAgents((prev) => {
      const n = new Set(prev);
      if (n.has(eventId)) n.delete(eventId);
      else n.add(eventId);
      return n;
    });
  }

  function toggleToolType(type: string) {
    setExpandedToolTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function toggleSkill(key: string) {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return {
    expandedAgents,
    expandedEventIds,
    setExpandedEventIds,
    expandedToolTypes,
    expandedSkills,
    collapsedTurns,
    setCollapsedTurns,
    selectedLauncherId,
    setSelectedLauncherId,
    expandEvent,
    expandTurnForEvent,
    toggleTurn,
    toggleAgent,
    toggleToolType,
    toggleSkill,
  };
}
