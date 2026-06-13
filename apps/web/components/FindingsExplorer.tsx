"use client";

// components/FindingsExplorer.tsx — the Findings master-detail, shared by both
// the cross-session Findings AXIS (route /findings) and the per-session Findings
// TAB inside the session viewer.
//
// Iteration 2 (design/phase2-finding-depth-and-backlog.md "イテレーション2"):
// V1 (Analysis-forward) is the base. The eight fixes from the round-1 screen
// review are implemented here:
//   1. Analysis stays as ONE grouped block (WHY / INTENT / IMPACT together).
//   2. The analysis block is neutral (hairline + panel ground + a source tag),
//      NOT a flood of accent-blue.
//   3. No orphaned summary line — finding.body is folded into the analysis block.
//   4. No duplicate navigation — the session is a plain label; VIEW SESSION /
//      VIEW TURN are the single way into the transcript.
//   5. Status is read in ONE place — a single verdict+backlog cell per list row.
//   6. No sticky verdict bar. The screen is a fixed header + THREE inner panels,
//      each scrolling inside its own box (minmax(0,…) + min-height:0 + overflow):
//        ① findings list           (left, scrolls)
//        ② analysis + verdict + backlog state (top of detail, shallow, no scroll)
//        ③ evidence / session body (bottom of detail, the ONLY deep scroll)
//   7. Tabs are Triage (pending) / Backlog (accepted & open) / All. No "Decided".
//   8. dual-operability: backlog transitions hit the same actor-stamped HTTP API
//      a future agent tool will call; "discuss / deepen with agent" placeholders.
//
// IA principle (design/ui-design-language.md, 2026-06-12): the cross-session
// theme lives on the global bar; the session viewer's tab shows ONLY findings
// attached to that one session. This component is parameterised by `mode`:
//   • mode "axis"    — the /findings screen (session filter; deep-link jumps).
//   • mode "session" — the viewer tab (pre-scoped; in-page jumps via the host).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RUNNER_LABEL } from "@/lib/runner-display";
import { parseStamp, shortModel } from "@lathe/shared";
import type {
  BacklogStatus,
  Finding,
  FindingEvidence,
  FindingEvidenceNarrative,
  FindingVerdict,
  FindingVerdictValue,
  Session,
  TurnContext,
  TurnContextEvent,
} from "@/lib/types";

// Triage = still pending (needs a verdict). Backlog = accepted AND still open
// (the live improvement list). All = everything, including rejected / addressed /
// dismissed (those are read here, not on a tab of their own — fix #7).
export type FindingTab = "triage" | "backlog" | "all";

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

const BACKLOG_LABEL: Record<BacklogStatus, string> = {
  open: "Open",
  addressed: "Addressed",
  dismissed: "Dismissed",
};

// iteration-3 fix #4: per-state intent shown on hover. Dismiss is explicitly the
// soft "won't fix — keep for record" so it never reads as a delete.
const BACKLOG_INTENT: Record<BacklogStatus, string> = {
  open: "open — still on the improvement backlog",
  addressed: "addressed — harness was changed to fix this",
  dismissed: "won't fix — keep for record (not deleted)",
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

// One evidence group: a stretch of evidence that shares the same (session, turn),
// collapsed into one card whose header is the session + turn position + the single
// USER ASKED prompt, with one row per step inside. Evidence that lacks a
// resolvable (sessionId, turn) each become a singleton group. Pure VIEW transform.
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

function TurnEventRow({
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
      data-seq={event.seq}
      data-type={event.type}
      data-evidence={event.isEvidence ? "true" : undefined}
      onClick={onClick}
      title={onClick ? "Jump to this step in the transcript" : undefined}
    >
      <span className="finding-turn-event-seq mono">{event.seq}</span>
      <span className="finding-turn-event-type">{label}</span>
      <span className="finding-turn-event-body">
        {event.command ? (
          <code className="finding-turn-event-cmd mono">{event.command}</code>
        ) : (
          <span className="finding-turn-event-text">{event.text ?? event.title}</span>
        )}
      </span>
      {event.exitCode != null && (
        <span className={`finding-turn-event-exit mono ${event.exitCode === 0 ? "ok" : "err"}`}>
          exit {event.exitCode}
        </span>
      )}
    </Tag>
  );
}

// The single status cell rendered in each list row AND in the detail header
// (fix #5: status read in one place). Verdict first, then — only when accepted —
// the backlog lifecycle chip beside it. Pending shows just "Pending".
function StatusCell({
  verdict,
  backlogStatus,
}: {
  verdict: FindingVerdictValue | "pending";
  backlogStatus: BacklogStatus | null;
}) {
  return (
    <span className="finding-status-cell" data-verdict={verdict} data-backlog={backlogStatus ?? "none"}>
      <span className={`finding-verdict-chip ${verdict}`}>
        {verdict === "pending" ? "Pending" : findingVerdictLabel(verdict)}
      </span>
      {verdict === "accept" && backlogStatus && (
        <span className={`finding-backlog-chip ${backlogStatus}`}>{BACKLOG_LABEL[backlogStatus]}</span>
      )}
    </span>
  );
}

export default function FindingsExplorer({
  findings,
  setFindings,
  sessions,
  mode,
  scopeSessionId,
  resolveEvidence,
  initialStatusFilter = "triage",
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
  initialStatusFilter?: FindingTab;
  initialSessionFilter?: string;
  onJumpToSession?: (sessionId: string, findingId?: number) => void;
  onJumpToTurn?: (
    sessionId: string,
    turn: number,
    headSeq: number | null,
    findingId?: number,
  ) => void;
}) {
  const [tab, setTab] = useState<FindingTab>(initialStatusFilter);
  const [sessionFilter, setSessionFilter] = useState<string>(initialSessionFilter ?? "all");
  const [selectedFindingId, setSelectedFindingId] = useState<number | null>(null);
  const [reasonDrafts, setReasonDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [backlogBusy, setBacklogBusy] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [recentVerdict, setRecentVerdict] = useState<{
    findingId: number;
    verdictId: number;
    verdict: FindingVerdictValue;
    title: string;
  } | null>(null);

  // Embedded turn transcript: which evidence groups are expanded + a lazily-fetched
  // per-(session,turn) cache, keyed by `${sessionId}::${turn}`.
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [turnContexts, setTurnContexts] = useState<
    Record<string, { loading: boolean; error: string | null; data: TurnContext | null }>
  >({});
  const turnFetchSeen = useRef<Set<string>>(new Set());

  const turnKey = useCallback((sessionId: string, turn: number) => `${sessionId}::${turn}`, []);

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
        turnFetchSeen.current.delete(key);
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

  // session-scoped findings (the universe the tab is allowed to show)
  const scopedFindings = useMemo(() => {
    if (mode === "session" && scopeSessionId) {
      return findings.filter((finding) => findingTouchesSession(finding, scopeSessionId));
    }
    return findings;
  }, [findings, mode, scopeSessionId]);

  const triageCount = useMemo(
    () => scopedFindings.filter((finding) => !finding.verdict).length,
    [scopedFindings],
  );
  const backlogCount = useMemo(
    () =>
      scopedFindings.filter(
        (finding) => finding.verdict?.verdict === "accept" && finding.backlogStatus === "open",
      ).length,
    [scopedFindings],
  );

  const matchesTab = useCallback((finding: Finding, which: FindingTab): boolean => {
    if (which === "all") return true;
    if (which === "triage") return !finding.verdict;
    // backlog = accepted AND still open
    return finding.verdict?.verdict === "accept" && finding.backlogStatus === "open";
  }, []);

  const visibleFindings = useMemo(() => {
    return scopedFindings
      .filter((finding) => {
        if (!matchesTab(finding, tab)) return false;
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
  }, [scopedFindings, tab, sessionFilter, mode, matchesTab]);

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
        // actor lets the same endpoint serve human + agent operators (dual-
        // operability). The UI is "human"; a future agent tool sends "agent:<name>".
        body: JSON.stringify({ verdict, reason: reasonDrafts[finding.id] ?? "", actor: "human" }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        verdict?: FindingVerdict;
        backlogStatus?: BacklogStatus | null;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.verdict) {
        throw new Error(payload.error ?? "verdict failed");
      }
      setFindings((prev) =>
        prev.map((item) =>
          item.id === finding.id
            ? {
                ...item,
                verdict: payload.verdict!,
                backlogStatus: payload.backlogStatus ?? null,
              }
            : item,
        ),
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
        prev.map((item) =>
          item.id === recent.findingId ? { ...item, verdict: null, backlogStatus: null } : item,
        ),
      );
      setRecentVerdict(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Backlog transition (fix #8). Hits the SAME actor-stamped endpoint a future
  // agent tool will call; the UI just supplies actor:"human".
  async function setBacklog(finding: Finding, status: BacklogStatus) {
    if (backlogBusy[finding.id] || finding.backlogStatus === status) return;
    setError(null);
    setBacklogBusy((prev) => ({ ...prev, [finding.id]: true }));
    try {
      const response = await fetch(`/api/findings/${finding.id}/backlog`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, actor: "human" }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        backlogStatus?: BacklogStatus;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.backlogStatus) {
        throw new Error(payload.error ?? "backlog update failed");
      }
      setFindings((prev) =>
        prev.map((item) =>
          item.id === finding.id ? { ...item, backlogStatus: payload.backlogStatus! } : item,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBacklogBusy((prev) => ({ ...prev, [finding.id]: false }));
    }
  }

  // iteration-3 fix #1: All carries a count too (total findings in scope), so
  // the user sees the universe size — not just the two narrowed tabs.
  const TABS: ReadonlyArray<readonly [FindingTab, string, number | null]> = [
    ["triage", "Triage", triageCount],
    ["backlog", "Backlog", backlogCount],
    ["all", "All", scopedFindings.length],
  ];

  return (
    <div
      className="timeline findings-tab findings-md3"
      data-pending-count={triageCount}
      data-backlog-count={backlogCount}
      data-findings-mode={mode}
      data-active-tab={tab}
    >
      {/* ---- fixed header: tabs + counts + session filter (fix #6: never scrolls) ----
          iteration-3 fix #3: in axis mode this IS the page header (the separate
          sessbar row was removed). The cross-session description is inlined here
          so the chrome is two rows (global nav + this) instead of three. */}
      <div className="findings-tab-head" data-mode={mode}>
        <div className="findings-title">
          <span className="findings-label">Findings</span>
          <span className="count mono">{visibleFindings.length}</span>
          {mode === "axis" && (
            <span className="findings-axis-desc">
              All findings across every session — the cross-session axis.
            </span>
          )}
        </div>
        <span className="segmented findings-filter" title="Findings tab">
          {TABS.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? "active" : ""}
              data-tab={key}
              onClick={() => setTab(key)}
            >
              {label}
              {count != null && <span className="findings-tab-count mono">{count}</span>}
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
          {tab === "triage"
            ? "no findings awaiting triage"
            : tab === "backlog"
              ? "no open backlog items"
              : mode === "session"
                ? "no findings attached to this session"
                : "no findings match the current filters"}
        </div>
      ) : (
        <div className="findings-md3-grid">
          {/* ===== PANEL ① — findings list (independent scroll, fix #6) ===== */}
          <div className="findings-list" role="list" data-panel="list">
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
                  data-backlog={finding.backlogStatus ?? "none"}
                  data-evidence-count={finding.evidence.length}
                  aria-pressed={isActive}
                  onClick={() => selectFinding(finding.id)}
                >
                  <div className="finding-mainline">
                    <span className={`finding-kind-chip ${finding.kind}`}>
                      <span className="finding-kind-dot" aria-hidden />
                      {FINDING_KIND_LABEL[finding.kind]}
                    </span>
                    <div className="finding-title-body">
                      <div className="finding-title-text">{finding.title}</div>
                    </div>
                    {/* fix #5: ONE status cell (verdict + backlog together) */}
                    <StatusCell verdict={verdict} backlogStatus={finding.backlogStatus} />
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

          {/* ===== detail column = panel ② (shallow, fixed) + panel ③ (deep scroll) ===== */}
          {selectedFinding ? (
            (() => {
              const finding = selectedFinding;
              const verdict = finding.verdict?.verdict ?? "pending";
              const analysis = finding.analysis;
              const harnessLabel = finding.harnessVersionId
                ? `${finding.harnessProvider ?? "harness"} ${shortHash(
                    finding.harnessContentHash ?? finding.harnessVersionId,
                  )}`
                : "—";
              return (
                <div
                  className={`finding-detail3 ${verdict}`}
                  data-detail-finding-id={finding.id}
                  data-verdict={verdict}
                  data-backlog={finding.backlogStatus ?? "none"}
                >
                  {/* ----- PANEL ② — analysis + verdict + backlog (no scroll) ----- */}
                  <div className="finding-detail-fixed" data-panel="analysis">
                    <div className="finding-detail-head">
                      <span className={`finding-kind-chip ${finding.kind}`}>
                        <span className="finding-kind-dot" aria-hidden />
                        {FINDING_KIND_LABEL[finding.kind]}
                      </span>
                      {/* fix #5: same single status cell as the list */}
                      <StatusCell verdict={verdict} backlogStatus={finding.backlogStatus} />
                      <span className="finding-detail-head-spacer" />
                      <span className="finding-detail-meta">
                        <span className="mono">{finding.analyst}</span>
                        <span className="mono">conf {findingConfidenceLabel(finding.confidence)}</span>
                        <span className="mono">harness {harnessLabel}</span>
                      </span>
                    </div>
                    <h3 className="finding-detail-title">{finding.title}</h3>

                    {/* fix #1/#2/#3: ONE neutral analysis block. The finding's own
                        summary (body) becomes the lede of the block (no orphan
                        line), then WHY / INTENT / IMPACT as a grouped list. Ground
                        is a neutral sunken panel + hairline + a small source tag —
                        not a flood of accent blue. */}
                    {(analysis || finding.body) && (
                      <section className="finding-analysis" data-has-analysis={analysis ? "true" : "false"}>
                        <div className="finding-analysis-head">
                          <span className="finding-section-label">Analysis</span>
                          <span className="finding-analysis-source mono" title="Who produced this analysis">
                            {finding.analyst}
                          </span>
                        </div>
                        {finding.body && <p className="finding-analysis-lede">{finding.body}</p>}
                        {analysis ? (
                          <dl className="finding-analysis-grid">
                            {analysis.agentIntent && (
                              <div className="finding-analysis-item" data-field="intent">
                                <dt className="finding-analysis-key">Intent</dt>
                                <dd className="finding-analysis-val">{analysis.agentIntent}</dd>
                              </div>
                            )}
                            {analysis.causeHypothesis && (
                              <div className="finding-analysis-item" data-field="why">
                                <dt className="finding-analysis-key">Why</dt>
                                <dd className="finding-analysis-val">{analysis.causeHypothesis}</dd>
                              </div>
                            )}
                            {analysis.impact && (
                              <div className="finding-analysis-item" data-field="impact">
                                <dt className="finding-analysis-key">Impact</dt>
                                <dd className="finding-analysis-val">{analysis.impact}</dd>
                              </div>
                            )}
                          </dl>
                        ) : (
                          <p className="finding-analysis-none mono">no deep-dive analysis</p>
                        )}
                      </section>
                    )}

                    {/* verdict + backlog — the decision controls, shallow, always
                        in view without scrolling (fix #6). */}
                    <div className="finding-decision">
                      <div className="finding-decision-row">
                        <span className="finding-section-label">Verdict</span>
                        {finding.verdict ? (
                          <div className="finding-verdict-decided">
                            <StatusCell verdict={verdict} backlogStatus={finding.backlogStatus} />
                            <span className="mono finding-verdict-by">
                              {finding.verdict.decidedBy} · {finding.verdict.reason || "no reason"}
                            </span>
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

                      {/* backlog lifecycle — visible once accepted (fix #8). The
                          three states are a segmented control hitting the actor-
                          stamped backlog API. Accept = "added to the backlog as
                          Open"; the user (or an agent) moves it to Addressed /
                          Dismissed by hand (harness edits stay manual, P2). */}
                      {finding.verdict?.verdict === "accept" && (
                        <div className="finding-decision-row">
                          <span className="finding-section-label">Backlog</span>
                          <div className="finding-backlog-controls">
                            <span className="segmented finding-backlog-seg" title="Backlog state">
                              {(["open", "addressed", "dismissed"] as const).map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className={finding.backlogStatus === s ? "active" : ""}
                                  data-backlog-target={s}
                                  disabled={!!backlogBusy[finding.id]}
                                  onClick={() => void setBacklog(finding, s)}
                                  // iteration-3 fix #4: Dismiss is a SOFT "won't
                                  // fix" — kept for the record, not deleted. The
                                  // tooltip spells the intent out so it reads as a
                                  // decision, not a destructive action.
                                  title={BACKLOG_INTENT[s]}
                                >
                                  {BACKLOG_LABEL[s]}
                                </button>
                              ))}
                            </span>
                            <span className="finding-boundary-note">
                              Harness edits are manual (P2 boundary)
                            </span>
                          </div>
                        </div>
                      )}

                      {/* dual-operability placeholder (fix #8): the same finding
                          will be hand-off-able to the P2.5 chat/agent. No-op now. */}
                      <div className="finding-agent-row" data-agent-actions="placeholder">
                        <button
                          type="button"
                          className="finding-agent-action"
                          disabled
                          title="Open this finding in the agent chat (coming in P2.5)"
                        >
                          Discuss with agent
                        </button>
                        <button
                          type="button"
                          className="finding-agent-action"
                          disabled
                          title="Ask the agent to deepen this analysis (coming in P2.5)"
                        >
                          Deepen with agent
                        </button>
                        <span className="finding-agent-hint mono">agent tools land in P2.5</span>
                      </div>
                    </div>
                  </div>

                  {/* ----- PANEL ③ — evidence / session body (the deep scroll) ----- */}
                  <div className="finding-detail-scroll" data-panel="evidence">
                    <div className="finding-detail-section">
                      <div className="finding-section-label">Evidence · {finding.evidence.length}</div>
                      <div className="finding-evidence-cards">
                        {groupEvidence(finding.evidence).map((group) => {
                          const narrative = group.narrative;
                          const anyResolved = group.members.some(
                            (member) => resolveEvidence(member).resolved,
                          );
                          const repeats = group.members.length;
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
                          const turnSessionId = group.sessionId;
                          const turnNumber = group.turn;
                          const canTurnJump = turnSessionId != null && turnNumber != null;
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
                              className={`finding-evidence-card${anyResolved ? "" : " stale"}`}
                              data-evidence-kind={group.members[0].subjectKind}
                              data-evidence-id={group.members[0].id}
                              data-group-key={group.key}
                              data-group-size={repeats}
                              data-resolved={anyResolved ? "true" : "false"}
                            >
                              {/* fix #4: the session is a PLAIN label, not a button.
                                  VIEW SESSION (below) is the single way into the
                                  full transcript — the title is no longer a second
                                  duplicate link. */}
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
                              {(positionLabel || repeats > 1 || canTurnJump || narrative?.sessionId) && (
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
                                      title={`This finding fired ${repeats} times in the same turn`}
                                    >
                                      ×{repeats} repeats
                                    </span>
                                  )}
                                  <span className="finding-evidence-grouphead-spacer" />
                                  {/* fix #4: VIEW TURN / VIEW SESSION are the only
                                      jump controls; the per-step "step N →" chip
                                      and the session title link were redundant. */}
                                  <div className="finding-evidence-actions">
                                    {canTurnJump && (
                                      <button
                                        type="button"
                                        className="finding-evidence-action finding-evidence-action-turn"
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
                                        className="finding-evidence-action finding-evidence-action-session"
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
                                      className="finding-evidence-turn-toggle mono"
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
                              <div className="finding-evidence-steps">
                                {group.members.map((evidence, stepIndex) => {
                                  const target = resolveEvidence(evidence);
                                  const excerpt = evidence.excerpt;
                                  const stepSeq = excerpt?.seq ?? null;
                                  const stepLabel =
                                    stepSeq != null ? `STEP ${stepSeq}` : `STEP ${stepIndex + 1}`;
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
                                          title="Session-wide step number"
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
                                        {/* fix #4: no per-step jump link — VIEW TURN
                                            / VIEW SESSION above are the single exit.
                                            Unresolved steps show a quiet status. */}
                                        {!target.resolved && (
                                          <span
                                            className="finding-evidence-stale-tag mono"
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
                                            evidence not resolvable (no locator)
                                          </div>
                                        )
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
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
                              {turnExpanded && tkey && (
                                <div
                                  className="finding-turn-transcript"
                                  data-turn={turnNumber ?? undefined}
                                  data-session-id={turnSessionId ?? undefined}
                                >
                                  <div className="finding-turn-transcript-head">
                                    <span className="finding-evidence-microlabel">Turn transcript</span>
                                  </div>
                                  {turnState?.loading && (
                                    <div className="finding-turn-status mono">loading…</div>
                                  )}
                                  {turnState?.error && (
                                    <div className="finding-turn-status err mono">
                                      {turnState.error}
                                    </div>
                                  )}
                                  {turnState?.data && (
                                    <>
                                      <div className="finding-turn-events" role="list">
                                        {turnState.data.events.map((ev) => (
                                          <TurnEventRow
                                            key={ev.id}
                                            event={ev}
                                            onClick={
                                              onJumpToTurn && turnSessionId != null && turnNumber != null
                                                ? () => onJumpToTurn(turnSessionId, turnNumber, ev.seq)
                                                : undefined
                                            }
                                          />
                                        ))}
                                      </div>
                                      {turnState.data.truncated && (
                                        <div className="finding-turn-status mono">
                                          showing {turnState.data.events.length} of{" "}
                                          {turnState.data.totalEvents} steps — use VIEW SESSION for the rest
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
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="finding-detail3 finding-detail-empty">
              <div className="detail-placeholder">Select a finding to inspect its analysis and evidence</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
