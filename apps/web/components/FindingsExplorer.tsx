"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RUNNER_LABEL } from "@/lib/runner-display";
import { parseStamp, shortModel } from "@lathe/shared";
import {
  FINDING_KIND_LABEL,
  TurnEventRow,
  evidenceSessionId,
  findingConfidenceLabel,
  findingTouchesSession,
  findingVerdictLabel,
  groupEvidence,
  shortHash,
  type FindingStatusFilter,
  type ResolvedEvidence,
} from "@/components/findings-explorer/model";
import type {
  Finding,
  FindingEvidence,
  FindingVerdict,
  FindingVerdictValue,
  Session,
  TurnContext,
} from "@/lib/types";

export {
  evidenceSessionId,
  findingTouchesSession,
  type ResolvedEvidence,
} from "@/components/findings-explorer/model";

export default function FindingsExplorer({
  findings,
  setFindings,
  sessions,
  mode,
  scopeSessionId,
  resolveEvidence,
  initialStatusFilter = "pending",
  initialSessionFilter,
  onJumpToSession,
  onJumpToTurn,
}: {
  findings: Finding[];
  setFindings: React.Dispatch<React.SetStateAction<Finding[]>>;
  sessions: Session[];
  mode: "axis" | "session";
  scopeSessionId?: string;
  resolveEvidence: (evidence: FindingEvidence) => ResolvedEvidence;
  initialStatusFilter?: FindingStatusFilter;
  initialSessionFilter?: string;
  onJumpToSession?: (sessionId: string, findingId?: number) => void;
  onJumpToTurn?: (
    sessionId: string,
    turn: number,
    headSeq: number | null,
    findingId?: number,
  ) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<FindingStatusFilter>(initialStatusFilter);
  const [sessionFilter, setSessionFilter] = useState<string>(initialSessionFilter ?? "all");
  const [selectedFindingId, setSelectedFindingId] = useState<number | null>(null);
  const [reasonDrafts, setReasonDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [recentVerdict, setRecentVerdict] = useState<{
    findingId: number;
    verdictId: number;
    verdict: FindingVerdictValue;
    title: string;
  } | null>(null);

  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [turnContexts, setTurnContexts] = useState<
    Record<string, { loading: boolean; error: string | null; data: TurnContext | null }>
  >({});
  const turnFetchSeen = useRef<Set<string>>(new Set());

  const turnKey = useCallback(
    (sessionId: string, turn: number) => `${sessionId}::${turn}`,
    [],
  );

  const fetchTurnContext = useCallback(
    async (sessionId: string, turn: number, evidenceSeqs: number[]) => {
      const key = `${sessionId}::${turn}`;
      if (turnFetchSeen.current.has(key)) return;
      turnFetchSeen.current.add(key);
      setTurnContexts((prev) => ({ ...prev, [key]: { loading: true, error: null, data: null } }));
      try {
        const qs = new URLSearchParams();
        qs.set("session", sessionId);
        qs.set("turn", String(turn));
        for (const seq of evidenceSeqs) qs.append("seq", String(seq));
        const response = await fetch(`/api/turn-context?${qs.toString()}`);
        const payload = (await response.json()) as { ok?: boolean; context?: TurnContext; error?: string };
        if (!response.ok || !payload.ok || !payload.context) {
          throw new Error(payload.error ?? "turn context failed");
        }
        setTurnContexts((prev) => ({
          ...prev,
          [key]: { loading: false, error: null, data: payload.context! },
        }));
      } catch (err) {
        turnFetchSeen.current.delete(key); // allow a retry on re-expand
        setTurnContexts((prev) => ({
          ...prev,
          [key]: { loading: false, error: (err as Error).message, data: null },
        }));
      }
    },
    [],
  );

  const toggleTurn = useCallback(
    (sessionId: string, turn: number, evidenceSeqs: number[]) => {
      const key = `${sessionId}::${turn}`;
      setExpandedTurns((prev) => {
        const next = !prev[key];
        if (next) void fetchTurnContext(sessionId, turn, evidenceSeqs);
        return { ...prev, [key]: next };
      });
    },
    [fetchTurnContext],
  );

  useEffect(() => {
    if (initialSessionFilter !== undefined) setSessionFilter(initialSessionFilter);
  }, [initialSessionFilter]);

  const scopedFindings = useMemo(() => {
    if (mode === "session" && scopeSessionId) {
      return findings.filter((finding) => findingTouchesSession(finding, scopeSessionId));
    }
    return findings;
  }, [findings, mode, scopeSessionId]);

  const pendingCount = useMemo(
    () => scopedFindings.filter((finding) => !finding.verdict).length,
    [scopedFindings],
  );

  const visibleFindings = useMemo(() => {
    return scopedFindings
      .filter((finding) => {
        if (statusFilter === "pending" && finding.verdict) return false;
        if (statusFilter === "decided" && !finding.verdict) return false;
        if (mode === "axis" && sessionFilter !== "all" && !findingTouchesSession(finding, sessionFilter)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (!a.verdict && b.verdict) return -1;
        if (a.verdict && !b.verdict) return 1;
        return b.confidence - a.confidence || b.id - a.id;
      });
  }, [scopedFindings, statusFilter, sessionFilter, mode]);

  const selectedFinding = useMemo(() => {
    if (selectedFindingId == null) return visibleFindings[0] ?? null;
    return (
      visibleFindings.find((finding) => finding.id === selectedFindingId) ??
      visibleFindings[0] ??
      null
    );
  }, [selectedFindingId, visibleFindings]);
  useEffect(() => {
    if (selectedFinding && selectedFinding.id !== selectedFindingId) {
      setSelectedFindingId(selectedFinding.id);
    }
  }, [selectedFinding, selectedFindingId]);

  const selectFinding = useCallback((id: number) => {
    setSelectedFindingId(id);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("finding", String(id));
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);

  const initialFindingApplied = useRef(false);
  useEffect(() => {
    if (initialFindingApplied.current) return;
    if (typeof window === "undefined") return;
    const raw = new URL(window.location.href).searchParams.get("finding");
    const id = raw ? Number(raw) : NaN;
    if (Number.isInteger(id) && findings.some((f) => f.id === id)) {
      initialFindingApplied.current = true;
      setSelectedFindingId(id);
    }
  }, [findings]);

  const sessionsWithFindings = useMemo(() => {
    if (mode !== "axis") return [] as Session[];
    const ids = new Set<string>();
    for (const finding of findings) {
      for (const evidence of finding.evidence) {
        const id = evidenceSessionId(evidence);
        if (id) ids.add(id);
      }
    }
    return sessions.filter((session) => ids.has(session.id));
  }, [findings, mode, sessions]);

  async function submitVerdict(finding: Finding, verdict: FindingVerdictValue) {
    if (busy[finding.id]) return;
    setError(null);
    setBusy((prev) => ({ ...prev, [finding.id]: true }));
    try {
      const response = await fetch(`/api/findings/${finding.id}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, reason: reasonDrafts[finding.id] ?? "" }),
      });
      const payload = (await response.json()) as { ok?: boolean; verdict?: FindingVerdict; error?: string };
      if (!response.ok || !payload.ok || !payload.verdict) {
        throw new Error(payload.error ?? "verdict failed");
      }
      setFindings((prev) =>
        prev.map((item) => (item.id === finding.id ? { ...item, verdict: payload.verdict! } : item)),
      );
      setReasonDrafts((prev) => ({ ...prev, [finding.id]: "" }));
      setRecentVerdict({
        findingId: finding.id,
        verdictId: payload.verdict.id,
        verdict,
        title: finding.title,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy((prev) => ({ ...prev, [finding.id]: false }));
    }
  }

  async function undoVerdict() {
    if (!recentVerdict) return;
    const recent = recentVerdict;
    setError(null);
    try {
      const response = await fetch(
        `/api/findings/${recent.findingId}/verdict?verdictId=${recent.verdictId}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "undo failed");
      setFindings((prev) =>
        prev.map((item) => (item.id === recent.findingId ? { ...item, verdict: null } : item)),
      );
      setRecentVerdict(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="timeline findings-tab findings-md" data-testid="findings-tab" data-pending-count={pendingCount} data-findings-mode={mode}>
      <div className="findings-tab-head" data-testid="findings-tab-head">
        <div className="findings-title" data-testid="findings-title">
          <span className="findings-label" data-testid="findings-label">Findings</span>
          <span className="count mono" data-testid="count">{visibleFindings.length}</span>
          <span className="finding-pending-count mono" data-testid="finding-pending-count">{pendingCount} pending</span>
        </div>
        <span className="segmented findings-filter" data-testid="findings-filter" title="Verdict filter">
          {(
            [
              ["pending", "Pending"],
              ["decided", "Decided"],
              ["all", "All"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={statusFilter === key ? "active" : ""}
              onClick={() => setStatusFilter(key)}
            >
              {label}
            </button>
          ))}
        </span>
        {mode === "axis" && (
          <label className="findings-session-select" data-testid="findings-session-select" title="Session filter">
            <span className="finding-section-label" data-testid="finding-section-label">Session</span>
            <select
              className="project-picker" data-testid="project-picker"
              value={sessionFilter}
              onChange={(event) => setSessionFilter(event.target.value)}
            >
              <option value="all">All sessions · {scopedFindings.length} findings</option>
              {sessionsWithFindings.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {recentVerdict && (
        <div
          className={`finding-verdict-toast ${recentVerdict.verdict}`} data-testid="finding-verdict-toast"
          data-finding-id={recentVerdict.findingId}
          data-verdict-id={recentVerdict.verdictId}
          data-verdict={recentVerdict.verdict}
        >
          <span className="finding-status-dot" data-testid="finding-status-dot" aria-hidden />
          <span>
            {findingVerdictLabel(recentVerdict.verdict)} · {recentVerdict.title}
          </span>
          <button type="button" className="btn btn-sm" data-testid="btn" onClick={undoVerdict}>
            Undo
          </button>
        </div>
      )}
      {error && <div className="finding-error" data-testid="finding-error">{error}</div>}
      {visibleFindings.length === 0 ? (
        <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
          {mode === "session"
            ? "No findings are attached to this session."
            : "No findings match the current filters."}
        </div>
      ) : (
        <div className="findings-md-grid" data-testid="findings-md-grid">
          {/* ---- master: compact list ---- */}
          <div className="findings-list" data-testid="findings-list" role="list">
            {visibleFindings.map((finding) => {
              const verdict = finding.verdict?.verdict ?? "pending";
              const isActive = selectedFinding?.id === finding.id;
              return (
                <button
                  key={finding.id}
                  type="button"
                  role="listitem"
                  className={`finding-row ${verdict}${isActive ? " active" : ""}`} data-testid="finding-row"
                  data-finding-id={finding.id}
                  data-kind={finding.kind}
                  data-analyst={finding.analyst}
                  data-verdict={verdict}
                  data-evidence-count={finding.evidence.length}
                  aria-pressed={isActive}
                  onClick={() => selectFinding(finding.id)}
                >
                  <div className="finding-mainline" data-testid="finding-mainline">
                    <span className={`finding-kind-chip ${finding.kind}`} data-testid="finding-kind-chip">
                      <span className="finding-kind-dot" data-testid="finding-kind-dot" aria-hidden />
                      {FINDING_KIND_LABEL[finding.kind]}
                    </span>
                    <div className="finding-title-body" data-testid="finding-title-body">
                      <div className="finding-title-text" data-testid="finding-title-text">{finding.title}</div>
                    </div>
                    <span className={`finding-verdict-chip ${verdict}`} data-testid="finding-verdict-chip">
                      {verdict === "pending" ? "Pending" : findingVerdictLabel(verdict)}
                    </span>
                  </div>
                  <div className="finding-meta-line" data-testid="finding-meta-line">
                    <span className="mono" data-testid="mono">{finding.analyst}</span>
                    <span className="mono" data-testid="mono">{findingConfidenceLabel(finding.confidence)}</span>
                    <span className="mono" data-testid="mono">{finding.evidence.length} evidence</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ---- detail: the evidence + verdict ---- */}
          {selectedFinding ? (
            (() => {
              const finding = selectedFinding;
              const verdict = finding.verdict?.verdict ?? "pending";
              const harnessLabel = finding.harnessVersionId
                ? `${finding.harnessProvider ?? "harness"} ${shortHash(
                    finding.harnessContentHash ?? finding.harnessVersionId,
                  )}`
                : "—";
              return (
                <div
                  className={`finding-detail ${verdict}`} data-testid="finding-detail"
                  data-detail-finding-id={finding.id}
                  data-verdict={verdict}
                >
                  <div className="finding-detail-head" data-testid="finding-detail-head">
                    <span className={`finding-kind-chip ${finding.kind}`} data-testid="finding-kind-chip">
                      <span className="finding-kind-dot" data-testid="finding-kind-dot" aria-hidden />
                      {FINDING_KIND_LABEL[finding.kind]}
                    </span>
                    <span className={`finding-verdict-chip ${verdict}`} data-testid="finding-verdict-chip">
                      {verdict === "pending" ? "Pending" : findingVerdictLabel(verdict)}
                    </span>
                  </div>
                  <h3 className="finding-detail-title" data-testid="finding-detail-title">{finding.title}</h3>
                  <div className="finding-detail-meta" data-testid="finding-detail-meta">
                    <span className="mono" data-testid="mono">{finding.analyst}</span>
                    <span className="mono" data-testid="mono">conf {findingConfidenceLabel(finding.confidence)}</span>
                    <span className="mono" data-testid="mono">harness {harnessLabel}</span>
                  </div>
                  {finding.body && <p className="finding-detail-body" data-testid="finding-detail-body">{finding.body}</p>}

                  <div className="finding-detail-section" data-testid="finding-detail-section">
                    <div className="finding-section-label" data-testid="finding-section-label">Evidence · {finding.evidence.length}</div>
                    <div className="finding-evidence-cards" data-testid="finding-evidence-cards">
                      {groupEvidence(finding.evidence).map((group) => {
                        const narrative = group.narrative;
                        // a group is "resolved" if any of its members resolves —
                        // the whole card is stale only when every step is.
                        const anyResolved = group.members.some(
                          (member) => resolveEvidence(member).resolved,
                        );
                        const repeats = group.members.length;
                        // session header is suppressed inside the session viewer
                        // (requirement A): every finding shown there already
                        // belongs to this session, so the SESSION row is noise.
                        // The cross-session AXIS keeps it (you may be looking at
                        // many sessions at once).
                        const showSessionHeader = mode === "axis" && narrative != null;
                        const positionLabel = narrative
                          ? [
                              narrative.turn != null && narrative.turnCount != null
                                ? `turn ${narrative.turn}/${narrative.turnCount}`
                                : narrative.turn != null
                                  ? `turn ${narrative.turn}`
                                  : null,
                              narrative.minutesFromStart != null
                                ? `+${narrative.minutesFromStart}m`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "";
                        // turn-level jump + embedded transcript anchors. Both need
                        // a (session, turn): available only when the group folded
                        // on a real narrative turn. evidenceSeqs flag this
                        // finding's own steps inside the inline transcript.
                        const turnSessionId = group.sessionId;
                        const turnNumber = group.turn;
                        const canTurnJump =
                          turnSessionId != null && turnNumber != null;
                        const evidenceSeqs = group.members
                          .map((m) => m.excerpt?.seq)
                          .filter((s): s is number => typeof s === "number");
                        const triggerSeq = narrative?.trigger?.seq ?? null;
                        const tkey =
                          turnSessionId != null && turnNumber != null
                            ? turnKey(turnSessionId, turnNumber)
                            : null;
                        const turnExpanded = tkey ? !!expandedTurns[tkey] : false;
                        const turnState = tkey ? turnContexts[tkey] : undefined;
                        return (
                          <div
                            key={group.key}
                            className={`finding-evidence-card${anyResolved ? "" : " stale"}`} data-testid="finding-evidence-card"
                            data-evidence-kind={group.members[0].subjectKind}
                            data-evidence-id={group.members[0].id}
                            data-group-key={group.key}
                            data-group-size={repeats}
                            data-resolved={anyResolved ? "true" : "false"}
                          >
                            {showSessionHeader && narrative && (
                              <button
                                type="button"
                                className="finding-evidence-session finding-evidence-session-jump" data-testid="finding-evidence-session"
                                data-session-id={narrative.sessionId}
                                title={`Open the full transcript for "${narrative.sessionTitle}" (same as VIEW SESSION)`}
                                onClick={() => onJumpToSession?.(narrative.sessionId, finding.id)}
                              >
                                <span className="finding-evidence-session-headline" data-testid="finding-evidence-session-headline">
                                  <span className="finding-evidence-microlabel" data-testid="finding-evidence-microlabel">Session</span>
                                  <span className="finding-evidence-session-arrow" data-testid="finding-evidence-session-arrow" aria-hidden>
                                    →
                                  </span>
                                </span>
                                <span
                                  className="finding-evidence-session-title" data-testid="finding-evidence-session-title"
                                  title={narrative.sessionTitle}
                                >
                                  {narrative.sessionTitle}
                                </span>
                                <span className="finding-evidence-session-meta mono" data-testid="finding-evidence-session-meta">
                                  {RUNNER_LABEL[narrative.runner as keyof typeof RUNNER_LABEL] ??
                                    narrative.runner}
                                  {narrative.model ? ` · ${shortModel(narrative.model)}` : ""}
                                  {` · ${parseStamp(narrative.startedAt).date} ${
                                    parseStamp(narrative.startedAt).time
                                  }`}
                                </span>
                              </button>
                            )}
                            {/* group header: turn position label (once) + repeat
                                count, then TWO always-visible primary actions —
                                VIEW TURN (transcript positioned at this turn) and
                                VIEW SESSION (the full transcript). Both carry a
                                title attribute spelling out the destination
                                (requirement C). The inline-transcript toggle is a
                                secondary, lower-priority control. */}
                            {(positionLabel ||
                              repeats > 1 ||
                              canTurnJump ||
                              narrative?.sessionId) && (
                              <div className="finding-evidence-grouphead" data-testid="finding-evidence-grouphead">
                                {positionLabel && (
                                  <span
                                    className="finding-evidence-position mono" data-testid="finding-evidence-position"
                                    title="Position of this turn within the run"
                                  >
                                    {positionLabel}
                                  </span>
                                )}
                                {repeats > 1 && (
                                  <span
                                    className="finding-evidence-repeats mono" data-testid="finding-evidence-repeats"
                                    data-repeats={repeats}
                                    title={`This finding fired ${repeats} times in the same turn — the same instruction kept repeating`}
                                  >
                                    ×{repeats} repeats
                                  </span>
                                )}
                                <span className="finding-evidence-grouphead-spacer" data-testid="finding-evidence-grouphead-spacer" />
                                <div className="finding-evidence-actions" data-testid="finding-evidence-actions">
                                  {canTurnJump && (
                                    <button
                                      type="button"
                                      className="finding-evidence-action finding-evidence-action-turn" data-testid="finding-evidence-action-turn"
                                      data-turn={turnNumber ?? undefined}
                                      title="Open the transcript at this turn"
                                      onClick={() =>
                                        onJumpToTurn?.(
                                          turnSessionId!,
                                          turnNumber!,
                                          triggerSeq,
                                          finding.id,
                                        )
                                      }
                                    >
                                      <span>VIEW TURN</span>
                                      <span aria-hidden>→</span>
                                    </button>
                                  )}
                                  {narrative?.sessionId && (
                                    <button
                                      type="button"
                                      className="finding-evidence-action finding-evidence-action-session" data-testid="finding-evidence-action-session"
                                      data-session-id={narrative.sessionId}
                                      title="Open the full session transcript"
                                      onClick={() =>
                                        onJumpToSession?.(narrative.sessionId, finding.id)
                                      }
                                    >
                                      <span>VIEW SESSION</span>
                                      <span aria-hidden>→</span>
                                    </button>
                                  )}
                                </div>
                                {canTurnJump && (
                                  <button
                                    type="button"
                                    className="finding-evidence-turn-toggle mono" data-testid="finding-evidence-turn-toggle"
                                    data-turn={turnNumber ?? undefined}
                                    aria-expanded={turnExpanded}
                                    title="Show this turn's transcript inline, without leaving this screen"
                                    onClick={() =>
                                      toggleTurn(turnSessionId!, turnNumber!, evidenceSeqs)
                                    }
                                  >
                                    <span aria-hidden>{turnExpanded ? "▾" : "▸"}</span>
                                    {turnExpanded ? "hide transcript" : "inline transcript"}
                                  </button>
                                )}
                              </div>
                            )}
                            {/* USER ASKED — the trigger prompt, shown once for the
                                whole group (it is identical across the steps). */}
                            {narrative?.trigger && (
                              <div className="finding-evidence-trigger" data-testid="finding-evidence-trigger">
                                <span className="finding-evidence-microlabel" data-testid="finding-evidence-microlabel">User asked</span>
                                <p className="finding-evidence-trigger-text" data-testid="finding-evidence-trigger-text">
                                  {narrative.trigger.text}
                                </p>
                                <span className="finding-evidence-trigger-seq mono" data-testid="finding-evidence-trigger-seq">
                                  step {narrative.trigger.seq}
                                </span>
                              </div>
                            )}
                            {/* one row per step (the seq is the session-wide step
                                index; hover spells that out). */}
                            <div className="finding-evidence-steps" data-testid="finding-evidence-steps">
                              {group.members.map((evidence, stepIndex) => {
                                const target = resolveEvidence(evidence);
                                const excerpt = evidence.excerpt;
                                const stepSeq = excerpt?.seq ?? null;
                                const stepLabel =
                                  stepSeq != null
                                    ? `STEP ${stepSeq}`
                                    : `STEP ${stepIndex + 1}`;
                                return (
                                  <div
                                    key={evidence.id}
                                    className={`finding-evidence-step${target.resolved ? "" : " stale"}`} data-testid="finding-evidence-step"
                                    data-evidence-kind={evidence.subjectKind}
                                    data-evidence-id={evidence.id}
                                    data-step-seq={stepSeq ?? undefined}
                                    data-resolved={target.resolved ? "true" : "false"}
                                  >
                                    <div className="finding-evidence-stephead" data-testid="finding-evidence-stephead">
                                      <span
                                        className="finding-evidence-stepno mono" data-testid="finding-evidence-stepno"
                                        title="Session-wide step number (the step's seq within the whole run)"
                                      >
                                        {stepLabel}
                                      </span>
                                      <span className="finding-evidence-kind" data-testid="finding-evidence-kind">
                                        {evidence.subjectKind}
                                      </span>
                                      {excerpt?.exitCode != null && (
                                        <span
                                          className={`finding-evidence-exit mono ${
                                            excerpt.exitCode === 0 ? "ok" : "err"
                                          }`} data-testid="finding-evidence-exit"
                                        >
                                          exit {excerpt.exitCode}
                                        </span>
                                      )}
                                      <span className="finding-evidence-stepspacer" data-testid="finding-evidence-stepspacer" />
                                      {target.resolved ? (
                                        <button
                                          type="button"
                                          className="finding-evidence finding-evidence-jump" data-testid="finding-evidence"
                                          data-evidence-kind={evidence.subjectKind}
                                          data-evidence-id={evidence.id}
                                          data-resolved="true"
                                          title={`${target.title} — jump to the Transcript`}
                                          onClick={target.jump}
                                        >
                                          <span className="mono" data-testid="mono">{target.label}</span>
                                          <span aria-hidden>→</span>
                                        </button>
                                      ) : (
                                        <span
                                          className="finding-evidence stale" data-testid="finding-evidence"
                                          data-evidence-kind={evidence.subjectKind}
                                          data-evidence-id={evidence.id}
                                          data-resolved="false"
                                          title={target.title}
                                        >
                                          {target.label}
                                        </span>
                                      )}
                                    </div>
                                    {evidence.note && (
                                      <div className="finding-evidence-note" data-testid="finding-evidence-note">{evidence.note}</div>
                                    )}
                                    {excerpt ? (
                                      <div
                                        className="finding-excerpt" data-testid="finding-excerpt"
                                        data-excerpt-seq={excerpt.seq}
                                      >
                                        {/* Evidence excerpts scroll horizontally on a long
                                            no-wrap command (the worst-case 140-char rg
                                            one-liner): data-scroll exempts them from the
                                            no-overflow gate — they absorb the width in their
                                            own box, never widening the grid/page. */}
                                        {excerpt.command && (
                                          <pre className="code-block cmd finding-excerpt-pre" data-testid="finding-excerpt-pre" data-scroll>
                                            {excerpt.command}
                                          </pre>
                                        )}
                                        {excerpt.output ? (
                                          <pre className="code-block output finding-excerpt-pre" data-testid="finding-excerpt-pre" data-scroll>
                                            {excerpt.output}
                                          </pre>
                                        ) : (
                                          !excerpt.command && (
                                            <div className="finding-excerpt-empty mono" data-testid="finding-excerpt-empty">
                                              {excerpt.title || "(no command / output captured)"}
                                            </div>
                                          )
                                        )}
                                      </div>
                                    ) : (
                                      !target.resolved && (
                                        <div className="finding-excerpt-empty mono" data-testid="finding-excerpt-empty">
                                          evidence not resolvable (no locator)
                                        </div>
                                      )
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {/* AFTERWARD — once for the group, after the last step
                                (requirement B). Use the aftermath of the last
                                member that carries one. */}
                            {(() => {
                              const last = [...group.members]
                                .reverse()
                                .find((member) => member.excerpt?.narrative?.aftermath);
                              const aftermath = last?.excerpt?.narrative?.aftermath;
                              if (!aftermath) return null;
                              return (
                                <div
                                  className="finding-evidence-after" data-testid="finding-evidence-after"
                                  data-after-seq={aftermath.seq}
                                >
                                  <span className="finding-evidence-microlabel" data-testid="finding-evidence-microlabel">Afterward</span>
                                  <div className="finding-evidence-after-meta mono" data-testid="finding-evidence-after-meta">
                                    <span>step {aftermath.seq}</span>
                                    <span>{aftermath.type}</span>
                                  </div>
                                  <p className="finding-evidence-after-text" data-testid="finding-evidence-after-text">{aftermath.text}</p>
                                </div>
                              );
                            })()}
                            {/* EMBEDDED TRANSCRIPT (requirement B) — the events of
                                this very turn, lazily fetched, in a compact bounded
                                scroll region so the user reads the surrounding
                                context without leaving the triage screen. */}
                            {turnExpanded && tkey && (
                              <div
                                className="finding-turn-transcript" data-testid="finding-turn-transcript"
                                data-turn={turnNumber ?? undefined}
                                data-session-id={turnSessionId ?? undefined}
                              >
                                <div className="finding-turn-transcript-head" data-testid="finding-turn-transcript-head">
                                  <span className="finding-evidence-microlabel" data-testid="finding-evidence-microlabel">
                                    Turn transcript
                                  </span>
                                  {/* No "open in session" here — VIEW TURN /
                                      VIEW SESSION in the group header are the
                                      single, always-visible way out (requirement
                                      C: the duplicate link is removed). */}
                                </div>
                                {turnState?.loading && (
                                  <div className="finding-turn-status mono" data-testid="finding-turn-status">loading…</div>
                                )}
                                {turnState?.error && (
                                  <div className="finding-turn-status err mono" data-testid="finding-turn-status">
                                    {turnState.error}
                                  </div>
                                )}
                                {turnState?.data && (
                                  <>
                                    <div className="finding-turn-events" data-testid="finding-turn-events" role="list">
                                      {turnState.data.events.map((ev) => (
                                        <TurnEventRow
                                          key={ev.id}
                                          event={ev}
                                          onClick={
                                            onJumpToTurn && turnSessionId != null && turnNumber != null
                                              ? () =>
                                                  onJumpToTurn(
                                                    turnSessionId,
                                                    turnNumber,
                                                    ev.seq,
                                                  )
                                              : undefined
                                          }
                                        />
                                      ))}
                                    </div>
                                    {turnState.data.truncated && (
                                      <div className="finding-turn-status mono" data-testid="finding-turn-status">
                                        showing {turnState.data.events.length} of{" "}
                                        {turnState.data.totalEvents} steps — use VIEW SESSION for the
                                        rest
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* verdict — sticky to the detail panel's bottom edge so
                      Accept/Reject is reachable without scrolling past long
                      evidence (requirement C); the evidence scrolls beneath it. */}
                  <div className="finding-detail-section finding-verdict-section finding-verdict-sticky" data-testid="finding-detail-section">
                    <div className="finding-section-label" data-testid="finding-section-label">Verdict</div>
                    {finding.verdict ? (
                      <div className="finding-verdict-decided" data-testid="finding-verdict-decided">
                        <span className={`finding-verdict-chip ${verdict}`} data-testid="finding-verdict-chip">
                          {findingVerdictLabel(finding.verdict.verdict)}
                        </span>
                        <span className="mono" data-testid="mono">
                          {finding.verdict.decidedBy} · {finding.verdict.reason || "no reason"}
                        </span>
                        {finding.verdict.verdict === "accept" && (
                          <div className="finding-boundary-note" data-testid="finding-boundary-note">
                            Harness edits are manual (P2 boundary)
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="finding-verdict-controls" data-testid="finding-verdict-controls">
                        <input
                          className="finding-verdict-reason" data-testid="finding-verdict-reason"
                          value={reasonDrafts[finding.id] ?? ""}
                          onChange={(event) =>
                            setReasonDrafts((prev) => ({
                              ...prev,
                              [finding.id]: event.target.value,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitVerdict(finding, "accept");
                            }
                          }}
                          placeholder="reason"
                          aria-label={`Reason for ${finding.title}`}
                        />
                        <button
                          type="button"
                          className="finding-verdict-btn accept" data-testid="finding-verdict-btn"
                          data-verdict="accept"
                          disabled={!!busy[finding.id]}
                          onClick={() => void submitVerdict(finding, "accept")}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="finding-verdict-btn reject" data-testid="finding-verdict-btn"
                          data-verdict="reject"
                          disabled={!!busy[finding.id]}
                          onClick={() => void submitVerdict(finding, "reject")}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="finding-detail finding-detail-empty" data-testid="finding-detail">
              <div className="detail-placeholder" data-testid="detail-placeholder">Select a finding to inspect its evidence</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
