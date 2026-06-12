"use client";

// components/FindingsExplorer.tsx — the Findings master-detail, shared by both
// the cross-session Findings AXIS (route /findings) and the per-session Findings
// TAB inside the session viewer.
//
// IA principle (design/ui-design-language.md, 2026-06-12): the cross-session
// theme lives on the global bar; the session viewer's tab shows ONLY findings
// attached to that one session. This component is the single rendering of the
// list + detail + verdict flow, parameterised by `mode`:
//
//   • mode "axis"    — the /findings screen. Session filter (All sessions / a
//                       specific session) is available; evidence jumps deep-link
//                       into the owning session's transcript (?session=&seq=).
//   • mode "session" — the viewer tab. Pre-scoped to one session; NO session
//                       filter (cross-session is the axis's job); evidence jumps
//                       are resolved in-page by the host (resolveEvidence prop).
//
// All verdict state (drafts, busy, toast, error, selection) is owned here so the
// component is self-contained on both screens.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RUNNER_LABEL } from "@/lib/runner-display";
import { parseStamp, shortModel } from "@lathe/shared";
import type {
  Finding,
  FindingEvidence,
  FindingEvidenceNarrative,
  FindingVerdict,
  FindingVerdictValue,
  Session,
} from "@/lib/types";

export type FindingStatusFilter = "pending" | "decided" | "all";

// One resolved evidence target — either an in-page jump (session viewer) or a
// deep link (the axis). `resolved:false` means the locator maps to nothing in
// the data available to the current screen.
export type ResolvedEvidence =
  | { resolved: true; kind: FindingEvidence["subjectKind"]; label: string; title: string; jump: () => void }
  | { resolved: false; kind: FindingEvidence["subjectKind"]; label: string; title: string };

const FINDING_KIND_LABEL: Record<Finding["kind"], string> = {
  failure_loop: "failure loop",
  unattributed_diff: "unattributed diff",
  excess_cost: "excess cost",
  risky_action: "risky action",
};

function findingConfidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function findingVerdictLabel(value: FindingVerdictValue): string {
  return value === "accept" ? "Accepted" : "Rejected";
}

function shortHash(value: string | null): string {
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

// One evidence group: a stretch of evidence that shares the same (session, turn).
// The user's complaint was 4 near-identical cards differing only by `step`; this
// collapses them into ONE card whose header is the session + turn position + the
// single USER ASKED prompt, with one row per step inside. Evidence that lacks a
// resolvable (sessionId, turn) — e.g. session-kind or unresolved locators — each
// become a singleton group so nothing regresses.
//
// Grouping is a pure VIEW transform over finding.evidence; the data contract
// (finding_evidence) is untouched (requirement B).
export interface EvidenceGroup {
  key: string;
  // narrative shared by the group (taken from the first member that has one).
  // null for singleton groups whose evidence carries no narrative.
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
    // Only fold together when BOTH the session and a turn number are known and a
    // narrative is present (so the shared header is meaningful). Otherwise the
    // evidence stands alone — keyed by its own id so it is never merged.
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
  // step order inside each group: by excerpt seq (the session-wide step index),
  // falling back to evidence id so the order is always deterministic.
  for (const group of groups) {
    group.members.sort((a, b) => {
      const sa = a.excerpt?.seq ?? Number.MAX_SAFE_INTEGER;
      const sb = b.excerpt?.seq ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.id - b.id;
    });
  }
  return groups;
}

export default function FindingsExplorer({
  findings,
  setFindings,
  sessions,
  mode,
  scopeSessionId,
  resolveEvidence,
  initialStatusFilter = "pending",
  initialSessionFilter,
  headerExtra,
}: {
  findings: Finding[];
  setFindings: React.Dispatch<React.SetStateAction<Finding[]>>;
  sessions: Session[];
  mode: "axis" | "session";
  // session viewer: the session the tab is scoped to. Findings whose evidence
  // does not touch this session are never shown (IA principle #2).
  scopeSessionId?: string;
  resolveEvidence: (evidence: FindingEvidence) => ResolvedEvidence;
  initialStatusFilter?: FindingStatusFilter;
  initialSessionFilter?: string;
  // a small slot rendered in the header (e.g. the "全 findings を見る" link from
  // the session tab into the axis).
  headerExtra?: React.ReactNode;
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

  useEffect(() => {
    if (initialSessionFilter !== undefined) setSessionFilter(initialSessionFilter);
  }, [initialSessionFilter]);

  // session-scoped findings (the universe the tab is allowed to show)
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
        // the explicit session filter only applies on the axis; the tab is
        // already pre-scoped to one session.
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

  // sessions that actually carry findings — used to populate the axis filter.
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
    <div className="timeline findings-tab findings-md" data-pending-count={pendingCount} data-findings-mode={mode}>
      <div className="findings-tab-head">
        <div className="findings-title">
          <span className="findings-label">Findings</span>
          <span className="count mono">{visibleFindings.length}</span>
          <span className="finding-pending-count mono">{pendingCount} pending</span>
        </div>
        <span className="segmented findings-filter" title="Verdict filter">
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
          <label className="findings-session-select" title="Session filter">
            <span className="finding-section-label">Session</span>
            <select
              className="project-picker"
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
        {headerExtra}
      </div>
      {recentVerdict && (
        <div
          className={`finding-verdict-toast ${recentVerdict.verdict}`}
          data-finding-id={recentVerdict.findingId}
          data-verdict-id={recentVerdict.verdictId}
        >
          <span className="finding-status-dot" aria-hidden />
          <span>
            {findingVerdictLabel(recentVerdict.verdict)} · {recentVerdict.title}
          </span>
          <button type="button" className="btn btn-sm" onClick={undoVerdict}>
            Undo
          </button>
        </div>
      )}
      {error && <div className="finding-error">{error}</div>}
      {visibleFindings.length === 0 ? (
        <div className="empty" style={{ padding: "16px" }}>
          {mode === "session"
            ? "No findings are attached to this session."
            : "No findings match the current filters."}
        </div>
      ) : (
        <div className="findings-md-grid">
          {/* ---- master: compact list ---- */}
          <div className="findings-list" role="list">
            {visibleFindings.map((finding) => {
              const verdict = finding.verdict?.verdict ?? "pending";
              const isActive = selectedFinding?.id === finding.id;
              return (
                <button
                  key={finding.id}
                  type="button"
                  role="listitem"
                  className={`finding-row ${verdict}${isActive ? " active" : ""}`}
                  data-finding-id={finding.id}
                  data-kind={finding.kind}
                  data-analyst={finding.analyst}
                  data-verdict={verdict}
                  data-evidence-count={finding.evidence.length}
                  aria-pressed={isActive}
                  onClick={() => setSelectedFindingId(finding.id)}
                >
                  <div className="finding-mainline">
                    <span className={`finding-kind-chip ${finding.kind}`}>
                      <span className="finding-kind-dot" aria-hidden />
                      {FINDING_KIND_LABEL[finding.kind]}
                    </span>
                    <div className="finding-title-body">
                      <div className="finding-title-text">{finding.title}</div>
                    </div>
                    <span className={`finding-verdict-chip ${verdict}`}>
                      {verdict === "pending" ? "Pending" : findingVerdictLabel(verdict)}
                    </span>
                  </div>
                  <div className="finding-meta-line">
                    <span className="mono">{finding.analyst}</span>
                    <span className="mono">{findingConfidenceLabel(finding.confidence)}</span>
                    <span className="mono">{finding.evidence.length} evidence</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ---- detail: the現物 + verdict ---- */}
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
                  className={`finding-detail ${verdict}`}
                  data-detail-finding-id={finding.id}
                  data-verdict={verdict}
                >
                  <div className="finding-detail-head">
                    <span className={`finding-kind-chip ${finding.kind}`}>
                      <span className="finding-kind-dot" aria-hidden />
                      {FINDING_KIND_LABEL[finding.kind]}
                    </span>
                    <span className={`finding-verdict-chip ${verdict}`}>
                      {verdict === "pending" ? "Pending" : findingVerdictLabel(verdict)}
                    </span>
                  </div>
                  <h3 className="finding-detail-title">{finding.title}</h3>
                  <div className="finding-detail-meta">
                    <span className="mono">{finding.analyst}</span>
                    <span className="mono">conf {findingConfidenceLabel(finding.confidence)}</span>
                    <span className="mono">harness {harnessLabel}</span>
                  </div>
                  {finding.body && <p className="finding-detail-body">{finding.body}</p>}

                  <div className="finding-detail-section">
                    <div className="finding-section-label">Evidence · {finding.evidence.length}</div>
                    <div className="finding-evidence-cards">
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
                        return (
                          <div
                            key={group.key}
                            className={`finding-evidence-card${anyResolved ? "" : " stale"}`}
                            data-evidence-kind={group.members[0].subjectKind}
                            data-evidence-id={group.members[0].id}
                            data-group-key={group.key}
                            data-group-size={repeats}
                            data-resolved={anyResolved ? "true" : "false"}
                          >
                            {showSessionHeader && narrative && (
                              <div
                                className="finding-evidence-session"
                                data-session-id={narrative.sessionId}
                              >
                                <span className="finding-evidence-microlabel">Session</span>
                                <span
                                  className="finding-evidence-session-title"
                                  title={narrative.sessionTitle}
                                >
                                  {narrative.sessionTitle}
                                </span>
                                <span className="finding-evidence-session-meta mono">
                                  {RUNNER_LABEL[narrative.runner as keyof typeof RUNNER_LABEL] ??
                                    narrative.runner}
                                  {narrative.model ? ` · ${shortModel(narrative.model)}` : ""}
                                  {` · ${parseStamp(narrative.startedAt).date} ${
                                    parseStamp(narrative.startedAt).time
                                  }`}
                                </span>
                              </div>
                            )}
                            {/* group header: turn position (once) + repeat count.
                                When the session header is hidden (session tab),
                                this carries the turn/time context that used to
                                live on the SESSION meta line. */}
                            {(positionLabel || repeats > 1) && (
                              <div className="finding-evidence-grouphead">
                                {positionLabel && (
                                  <span
                                    className="finding-evidence-position mono"
                                    title="Position of this turn within the run"
                                  >
                                    {positionLabel}
                                  </span>
                                )}
                                {repeats > 1 && (
                                  <span
                                    className="finding-evidence-repeats mono"
                                    data-repeats={repeats}
                                    title={`This finding fired ${repeats} times in the same turn — the same instruction kept repeating`}
                                  >
                                    ×{repeats} repeats
                                  </span>
                                )}
                              </div>
                            )}
                            {/* USER ASKED — the trigger prompt, shown once for the
                                whole group (it is identical across the steps). */}
                            {narrative?.trigger && (
                              <div className="finding-evidence-trigger">
                                <span className="finding-evidence-microlabel">User asked</span>
                                <p className="finding-evidence-trigger-text">
                                  {narrative.trigger.text}
                                </p>
                                <span className="finding-evidence-trigger-seq mono">
                                  step {narrative.trigger.seq}
                                </span>
                              </div>
                            )}
                            {/* one row per step (the seq is the session-wide step
                                index; hover spells that out). */}
                            <div className="finding-evidence-steps">
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
                                    className={`finding-evidence-step${target.resolved ? "" : " stale"}`}
                                    data-evidence-kind={evidence.subjectKind}
                                    data-evidence-id={evidence.id}
                                    data-step-seq={stepSeq ?? undefined}
                                    data-resolved={target.resolved ? "true" : "false"}
                                  >
                                    <div className="finding-evidence-stephead">
                                      <span
                                        className="finding-evidence-stepno mono"
                                        title="Session-wide step number (the step's seq within the whole run)"
                                      >
                                        {stepLabel}
                                      </span>
                                      <span className="finding-evidence-kind">
                                        {evidence.subjectKind}
                                      </span>
                                      {excerpt?.exitCode != null && (
                                        <span
                                          className={`finding-evidence-exit mono ${
                                            excerpt.exitCode === 0 ? "ok" : "err"
                                          }`}
                                        >
                                          exit {excerpt.exitCode}
                                        </span>
                                      )}
                                      <span className="finding-evidence-stepspacer" />
                                      {target.resolved ? (
                                        <button
                                          type="button"
                                          className="finding-evidence finding-evidence-jump"
                                          data-evidence-kind={evidence.subjectKind}
                                          data-evidence-id={evidence.id}
                                          data-resolved="true"
                                          title={`${target.title} — jump to the Transcript`}
                                          onClick={target.jump}
                                        >
                                          <span className="mono">{target.label}</span>
                                          <span aria-hidden>→</span>
                                        </button>
                                      ) : (
                                        <span
                                          className="finding-evidence stale"
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
                                      <div className="finding-evidence-note">{evidence.note}</div>
                                    )}
                                    {excerpt ? (
                                      <div
                                        className="finding-excerpt"
                                        data-excerpt-seq={excerpt.seq}
                                      >
                                        {excerpt.command && (
                                          <pre className="code-block cmd finding-excerpt-pre">
                                            {excerpt.command}
                                          </pre>
                                        )}
                                        {excerpt.output ? (
                                          <pre className="code-block output finding-excerpt-pre">
                                            {excerpt.output}
                                          </pre>
                                        ) : (
                                          !excerpt.command && (
                                            <div className="finding-excerpt-empty mono">
                                              {excerpt.title || "(no command / output captured)"}
                                            </div>
                                          )
                                        )}
                                      </div>
                                    ) : (
                                      !target.resolved && (
                                        <div className="finding-excerpt-empty mono">
                                          現物を解決できません（locator 未対応）
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
                                  className="finding-evidence-after"
                                  data-after-seq={aftermath.seq}
                                >
                                  <span className="finding-evidence-microlabel">Afterward</span>
                                  <div className="finding-evidence-after-meta mono">
                                    <span>step {aftermath.seq}</span>
                                    <span>{aftermath.type}</span>
                                  </div>
                                  <p className="finding-evidence-after-text">{aftermath.text}</p>
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* verdict — IN the detail panel, beside the evidence */}
                  <div className="finding-detail-section finding-verdict-section">
                    <div className="finding-section-label">Verdict</div>
                    {finding.verdict ? (
                      <div className="finding-verdict-decided">
                        <span className={`finding-verdict-chip ${verdict}`}>
                          {findingVerdictLabel(finding.verdict.verdict)}
                        </span>
                        <span className="mono">
                          {finding.verdict.decidedBy} · {finding.verdict.reason || "no reason"}
                        </span>
                        {finding.verdict.verdict === "accept" && (
                          <div className="finding-boundary-note">
                            ハーネス編集はユーザー手動（P2 境界）
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="finding-verdict-controls">
                        <input
                          className="finding-verdict-reason"
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
                          className="finding-verdict-btn accept"
                          disabled={!!busy[finding.id]}
                          onClick={() => void submitVerdict(finding, "accept")}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="finding-verdict-btn reject"
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
            <div className="finding-detail finding-detail-empty">
              <div className="detail-placeholder">Select a finding to inspect its evidence</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
