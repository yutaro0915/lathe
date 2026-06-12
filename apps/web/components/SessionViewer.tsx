"use client";

// components/SessionViewer.tsx — Screen A: fully-interactive session viewer.
//
// Client component. The route (app/page.tsx) is a thin server wrapper that
// loads the SessionBundle and the session list, then renders this. The ONLY
// interaction that navigates is switching sessions (router.push("/?session=…"));
// everything else is local React state (filters, tabs, selection, pins, notes).
//
// Visual structure, classNames and helpers are preserved from the original
// static app/page.tsx — this file adds interactivity + real data wiring.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TimeRibbon from "@/components/TimeRibbon";
import DiffViewer from "@/components/DiffViewer";
import SessionStatsView from "@/components/SessionStatsView";
import CostAnomalyChip from "@/components/CostAnomalyChip";
import Link from "next/link";
import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import {
  fmtCompact,
  fmtCost,
  fmtInt,
  fmtTok,
  humanizeDuration,
  parseStamp,
  shortModel,
} from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import type {
  Session,
  SessionBundle,
  TranscriptEvent,
  EventType,
  AnnotationKind,
  PullRequestSummary,
  Finding,
  FindingEvidence,
  FindingVerdict,
  FindingVerdictValue,
} from "@/lib/types";

function durLabel(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Map an event type onto a minimap "kind" class (legend buckets).
function minimapKind(t: EventType): string {
  switch (t) {
    case "user_message":
    case "assistant_message":
    case "thinking":
      return "message";
    case "bash":
    case "test":
    case "hook":
      return "tool";
    case "file_read":
    case "file_edit":
    case "file_write":
    case "memory":
      return "file";
    case "skill":
      return "skill";
    case "subagent":
      return "subagent";
    case "commit":
      return "git";
    case "error":
      return "error";
    default:
      return "tool";
  }
}

// All filterable event types, in legend order.
const ALL_TYPES: EventType[] = [
  "user_message",
  "assistant_message",
  "thinking",
  "file_read",
  "file_edit",
  "file_write",
  "bash",
  "subagent",
  "skill",
  "memory",
  "hook",
  "commit",
  "test",
  "todo",
  "error",
];

// Tools tab shows these "tool-ish" event types.
const TOOL_TYPES: EventType[] = ["bash", "file_read", "file_edit", "file_write", "test", "commit"];

type Tab = "transcript" | "tools" | "git" | "skills" | "subagents" | "annotations" | "findings" | "raw" | "stats";
type SortKey = "recent" | "oldest" | "tokens";
type FilterMode = "highlight" | "hide";
type FindingStatusFilter = "pending" | "decided" | "all";

type TurnFile = { id: string; path: string };
type TurnRollup = {
  turn: number;
  steps: number;
  edits: number;
  bash: number;
  errors: number;
  tokens: number;
  durationMs: number;
  wallDurationMs: number;
  costUsd: number | null;
  files: TurnFile[];
  summary: string;
  collapsed: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const LS_PINS = "lathe.pins";
const LS_NOTES = "lathe.notes";

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

function locatorNumber(evidence: FindingEvidence, keys: string[]): number | null {
  for (const key of keys) {
    const value = evidence.locator[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function evidenceSessionId(evidence: FindingEvidence): string | null {
  return (
    evidence.sessionId ??
    (evidence.subjectKind === "session" ? evidence.subjectId : null) ??
    locatorString(evidence, ["session_id", "sessionId", "session"])
  );
}

function findingTouchesSession(finding: Finding, sessionId: string): boolean {
  return finding.evidence.some((evidence) => evidenceSessionId(evidence) === sessionId);
}

function firstNonEmptyLine(text: string | null | undefined): string {
  return (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function readMetaCostUsd(e: TranscriptEvent): number | null {
  if (!e.meta) return null;
  try {
    const meta = JSON.parse(e.meta);
    return typeof meta.costUsd === "number" ? meta.costUsd : null;
  } catch {
    return null;
  }
}

function hmsToMs(ts: string): number | null {
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 60 * 60 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// ---- tiny JSON renderer for the Run JSON panel (.json-* spans) -------------

function JsonView({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  const out: React.ReactNode[] = [];
  out.push(
    <span key="open" className="json-punct">
      {"{\n"}
    </span>
  );
  entries.forEach(([k, v], i) => {
    const comma = i < entries.length - 1 ? "," : "";
    let valNode: React.ReactNode;
    if (v === null) valNode = <span className="json-num">null</span>;
    else if (typeof v === "number" || typeof v === "boolean")
      valNode = <span className="json-num">{String(v)}</span>;
    else valNode = <span className="json-str">{JSON.stringify(String(v))}</span>;
    out.push(
      <span key={`r${i}`}>
        {"  "}
        <span className="json-key">{JSON.stringify(k)}</span>
        <span className="json-punct">: </span>
        {valNode}
        <span className="json-punct">{comma}</span>
        {"\n"}
      </span>
    );
  });
  out.push(
    <span key="close" className="json-punct">
      {"}"}
    </span>
  );
  return <>{out}</>;
}

// ============================================================================

export default function SessionViewer({
  sessions,
  bundle,
  currentId,
  projects,
  sessionProject,
  sessionPrs,
  findings: initialFindings,
  initialTab = "transcript",
  initialFindingsSession,
  initialSeq,
}: {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
  // (project, sessions, cost) tuples just for the sidebar's project picker —
  // scoping the session LIST. Cross-session ANALYTICS live on /overview, not
  // inside the SessionViewer (which is per-session).
  projects: { project: string; sessions: number; cost: number; costKnown: boolean }[];
  sessionProject: Record<string, string>;
  sessionPrs: Record<string, PullRequestSummary[]>;
  findings: Finding[];
  initialTab?: Tab;
  initialFindingsSession?: string;
  initialSeq?: number;
}) {
  const router = useRouter();

  const primary = bundle.session;
  const primaryPrs = bundle.pullRequests;
  const events = bundle.events;
  const typeCounts = bundle.typeCounts;
  const annotations = bundle.annotations;
  const [findings, setFindings] = useState<Finding[]>(initialFindings);

  // ---- session-list controls (sidebar) -----------------------------------
  const [sessionSearch, setSessionSearch] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [errorsFilter, setErrorsFilter] = useState("any");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");

  // ---- timeline / tab / selection state -----------------------------------
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [findingStatusFilter, setFindingStatusFilter] = useState<FindingStatusFilter>("pending");
  const [findingSessionFilter, setFindingSessionFilter] = useState<string>(
    initialFindingsSession ?? "all",
  );
  // master-detail: which finding's現物 is open in the right detail panel. The
  // list rows no longer carry accept/reject — the verdict lives in the detail
  // panel, next to the evidence excerpts, so a decision is never made blind.
  const [selectedFindingId, setSelectedFindingId] = useState<number | null>(null);
  const [findingReasonDrafts, setFindingReasonDrafts] = useState<Record<number, string>>({});
  const [findingBusy, setFindingBusy] = useState<Record<number, boolean>>({});
  const [findingError, setFindingError] = useState<string | null>(null);
  const [recentFindingVerdict, setRecentFindingVerdict] = useState<{
    findingId: number;
    verdictId: number;
    verdict: FindingVerdictValue;
    title: string;
  } | null>(null);
  const [typeFilter, setTypeFilter] = useState<Set<EventType>>(() => new Set(ALL_TYPES));
  const [filterMode, setFilterMode] = useState<FilterMode>("hide");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  // turn groups: each top-level user_message starts a "Turn N" (matches Linked
  // Events numbering). Collapsing a turn hides the assistant/tool steps until
  // the NEXT user_message — so a long run can be scanned at the turn level and
  // then drilled into. Default = all open; the session-change effect below
  // collapses turns after the turn headers are known.
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());

  // ---- Subagents tab: which run is open ("overview" or a launcher event id) --
  const [subAgentTab, setSubAgentTab] = useState<string>("overview");
  // transcript → Git jump target (the edit whose diff to focus). Set only via the
  // "see this edit's diff" action; cleared when Git is opened from the tab bar.
  const [gitFocusEvent, setGitFocusEvent] = useState<string | undefined>(undefined);
  const [gitFocusFileId, setGitFocusFileId] = useState<string | undefined>(undefined);
  const [gitFocusHunkId, setGitFocusHunkId] = useState<string | undefined>(undefined);

  useEffect(() => {
    setFindings(initialFindings);
  }, [initialFindings]);
  useEffect(() => {
    setFindingSessionFilter(initialFindingsSession ?? "all");
  }, [initialFindingsSession]);

  // Selected event seed: the failing build (bash, exit != 0) is most
  // informative; fall back gracefully. Re-seed whenever the session changes.
  // default to the session's first top-level step (usually the opening prompt),
  // not an arbitrary tool — opening the panel on a random "tool" was confusing.
  const seedId = useMemo(() => {
    const first = events.find((e) => !e.parentId) ?? events[0];
    return first?.id;
  }, [events]);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(seedId);
  // a transiently-flashed step (deep-link / evidence jump): the row gets a brief
  // outline so the user can SEE where the jump landed. Cleared on a timer.
  const [flashEventId, setFlashEventId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setSelectedEventId(seedId);
  }, [seedId]);
  // re-seed the Subagents tab back to the overview when the session changes
  useEffect(() => {
    setSubAgentTab("overview");
  }, [primary.id]);

  // When an event is selected (from the timeline, the time ribbon, or an
  // annotation), bring its row into view in the current list — so clicking a
  // ribbon segment visibly "jumps" to that step, not just updates the aside.
  useEffect(() => {
    if (!selectedEventId || typeof document === "undefined") return;
    const sel =
      typeof CSS !== "undefined" && CSS.escape
        ? `[data-eid="${CSS.escape(selectedEventId)}"]`
        : null;
    if (!sel) return;
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: "center" });
  }, [selectedEventId, activeTab]);

  // ---- minimap zoom --------------------------------------------------------
  const [zoom, setZoom] = useState(1);

  // ---- pins + notes (localStorage) ----------------------------------------
  const [pins, setPins] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<string | null>(null); // open editor when non-null

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rawPins = window.localStorage.getItem(LS_PINS);
      if (rawPins) setPins(new Set(JSON.parse(rawPins) as string[]));
    } catch {
      /* ignore */
    }
    try {
      const rawNotes = window.localStorage.getItem(LS_NOTES);
      if (rawNotes) setNotes(JSON.parse(rawNotes) as Record<string, string>);
    } catch {
      /* ignore */
    }
  }, []);

  function persistPins(next: Set<string>) {
    setPins(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_PINS, JSON.stringify(Array.from(next)));
    }
  }
  function persistNotes(next: Record<string, string>) {
    setNotes(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_NOTES, JSON.stringify(next));
    }
  }

  // ---- copy feedback -------------------------------------------------------
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function copy(key: string, text: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1200);
  }
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // ---- derived: filtered + sorted session list ----------------------------
  const models = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.model) set.add(s.model);
    return Array.from(set);
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    let list = sessions.filter((s) => {
      if (q && !s.title.toLowerCase().includes(q)) return false;
      if (modelFilter !== "all" && s.model !== modelFilter) return false;
      if (errorsFilter === "yes" && s.errorCount === 0) return false;
      if (errorsFilter === "no" && s.errorCount > 0) return false;
      if (projectFilter !== "all" && (sessionProject[s.id] ?? "(no edits)") !== projectFilter)
        return false;
      return true;
    });
    list = [...list];
    if (sortKey === "recent") list.sort((a, b) => a.seq - b.seq);
    else if (sortKey === "oldest") list.sort((a, b) => b.seq - a.seq);
    else if (sortKey === "tokens") list.sort((a, b) => b.tokenUsage - a.tokenUsage);
    return list;
  }, [sessions, sessionSearch, modelFilter, errorsFilter, projectFilter, sortKey, sessionProject]);

  // ---- derived: filtered timeline events ----------------------------------
  // sub-agent child steps grouped under their launching event id
  const childrenByParent = useMemo(() => {
    const m = new Map<string, TranscriptEvent[]>();
    for (const e of events) {
      if (e.parentId) {
        const arr = m.get(e.parentId);
        if (arr) arr.push(e);
        else m.set(e.parentId, [e]);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => a.seq - b.seq);
    return m;
  }, [events]);

  // ---- sub-agent invocations -----------------------------------------------
  // One top-level `subagent` launcher = one distinct sub-agent RUN. The old tab
  // grouped by agent *type name* ("general-purpose"), mashing many separate runs
  // into one flat list. Group by the launcher instead so each run is its own unit.
  const invocations = useMemo(
    () => events.filter((e) => e.type === "subagent" && !e.parentId),
    [events]
  );

  // which transcript events produced a Git hunk (via attribution) — these offer a
  // "see this edit's diff" jump into the Git tab (the reverse link lives there).
  const eventsWithDiff = useMemo(() => {
    const s = new Set<string>();
    for (const hunkList of Object.values(bundle.hunks)) {
      for (const h of hunkList) {
        for (const a of bundle.attributions[h.id] ?? []) if (a.eventId) s.add(a.eventId);
      }
    }
    return s;
  }, [bundle.hunks, bundle.attributions]);

  // Roll up one invocation: its child steps, declared tool-call count, and whether
  // any step failed. Cheap enough to call inline while rendering.
  function summarizeInvocation(launcher: TranscriptEvent) {
    const kids = childrenByParent.get(launcher.id) ?? [];
    let toolUses: number | undefined;
    let model: string | undefined;
    let costUsd: number | undefined;
    let tokens: number | undefined;
    try {
      const m = launcher.meta ? JSON.parse(launcher.meta) : {};
      if (typeof m.toolUses === "number") toolUses = m.toolUses;
      if (typeof m.model === "string") model = m.model; // the model the sub-agent ran on
      if (typeof m.costUsd === "number") costUsd = m.costUsd; // priced from the sub-agent's own usage
      if (typeof m.tokens === "number") tokens = m.tokens; // same usage the cost was priced from
    } catch {
      /* ignore */
    }
    // Result = the RUN's own verdict (the launcher's is_error / exit), NOT a
    // roll-up of child failures. A grep that exits 1 mid-run does not make the
    // whole run "error". `failedSteps` is the separate, factual count of child
    // steps that exited non-zero (surfaced as its own chip, never as Result).
    let metaIsError: boolean | undefined;
    try {
      const m = launcher.meta ? JSON.parse(launcher.meta) : {};
      if (typeof m.isError === "boolean") metaIsError = m.isError;
    } catch {
      /* ignore */
    }
    const runFailed =
      metaIsError ?? (launcher.exitCode != null ? launcher.exitCode !== 0 : false);
    const failedSteps = kids.filter((k) => k.exitCode != null && k.exitCode !== 0).length;
    // observed fallback: tool-ish steps counted from the child transcript, for
    // runs that did not report a toolUses total of their own
    const observedTools = kids.filter(
      (k) => !["user_message", "assistant_message", "thinking"].includes(k.type),
    ).length;
    return { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools };
  }

  // The agent's own one-line summary of what it did (its result), else its title.
  function invocationSummaryLine(e: TranscriptEvent): string {
    const body = (e.body ?? "").trim();
    if (body) return body.split("\n").find((l) => l.trim()) ?? e.title;
    return e.title;
  }

  const matchesSearch = useMemo(() => {
    const q = transcriptSearch.trim().toLowerCase();
    return (e: TranscriptEvent) => {
      if (q) {
        const hay = `${e.title} ${e.command ?? ""} ${e.filePath ?? ""} ${e.body ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
  }, [transcriptSearch]);

  const matchesType = useMemo(() => {
    return (e: TranscriptEvent) => typeFilter.has(e.type);
  }, [typeFilter]);

  const shouldRenderTimelineEvent = useMemo(() => {
    return (e: TranscriptEvent) =>
      matchesSearch(e) && (filterMode === "highlight" || matchesType(e));
  }, [filterMode, matchesSearch, matchesType]);

  // top-level events drive the timeline + ribbon; children expand under parents
  const topEvents = useMemo(() => events.filter((e) => !e.parentId), [events]);
  const visibleEvents = useMemo(
    () => topEvents.filter(shouldRenderTimelineEvent),
    [topEvents, shouldRenderTimelineEvent]
  );

  // turn numbering: each top-level user_message starts a new turn. A row's
  // owning turn = the most recent user_message at or before it. The user_message
  // event itself IS the turn header; everything after it (assistant/tool/…)
  // belongs to that turn until the NEXT user_message.
  const { turnNumberByEventId, turnHeaderIds } = useMemo(() => {
    const turnNumberByEventId = new Map<string, number>();
    const turnHeaderIds = new Map<string, string>(); // event id -> header (user_message) id
    let n = 0;
    let header: string | null = null;
    for (const e of topEvents) {
      if (e.type === "user_message") {
        n += 1;
        header = e.id;
        turnNumberByEventId.set(e.id, n);
      }
      if (header) turnHeaderIds.set(e.id, header);
    }
    return { turnNumberByEventId, turnHeaderIds };
  }, [topEvents]);
  const turnCount = turnNumberByEventId.size;

  function toggleTurn(headerId: string) {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(headerId)) next.delete(headerId);
      else next.add(headerId);
      return next;
    });
  }
  function collapseAllTurns() {
    setCollapsedTurns(new Set(turnNumberByEventId.keys()));
  }
  function expandAllTurns() {
    setCollapsedTurns(new Set());
  }

  useEffect(() => {
    setCollapsedTurns(new Set(turnNumberByEventId.keys()));
  }, [primary.id, turnNumberByEventId]);

  const changedFileByPath = useMemo(() => {
    const m = new Map<string, TurnFile>();
    for (const f of bundle.changedFiles) m.set(f.path, { id: f.id, path: f.path });
    return m;
  }, [bundle.changedFiles]);

  const changedFilesByEventId = useMemo(() => {
    const m = new Map<string, Map<string, TurnFile>>();
    const add = (eventId: string | null | undefined, file: TurnFile | undefined) => {
      if (!eventId || !file) return;
      let filesForEvent = m.get(eventId);
      if (!filesForEvent) {
        filesForEvent = new Map();
        m.set(eventId, filesForEvent);
      }
      filesForEvent.set(file.id, file);
    };

    for (const [eventId, files] of Object.entries(bundle.eventFiles)) {
      for (const f of files) add(eventId, changedFileByPath.get(f.path));
    }
    for (const f of bundle.changedFiles) {
      for (const h of bundle.hunks[f.id] ?? []) {
        for (const a of bundle.attributions[h.id] ?? []) add(a.eventId, { id: f.id, path: f.path });
      }
    }
    return m;
  }, [bundle.attributions, bundle.changedFiles, bundle.eventFiles, bundle.hunks, changedFileByPath]);

  const turnRollups = useMemo(() => {
    type MutableTurnRollup = Omit<TurnRollup, "files" | "collapsed"> & {
      fileMap: Map<string, TurnFile>;
    };

    const rollups = new Map<string, MutableTurnRollup>();
    const collect = (r: MutableTurnRollup, e: TranscriptEvent) => {
      if (e.type === "file_edit" || e.type === "file_write") r.edits += 1;
      if (e.type === "bash") r.bash += 1;
      if (e.type === "error" || (e.exitCode != null && e.exitCode !== 0)) r.errors += 1;
      r.tokens += e.tokenUsage ?? 0;
      r.durationMs += e.durationMs ?? 0;

      const directCost = readMetaCostUsd(e);
      const tokenCost =
        directCost == null && primary.costUsd != null && primary.tokenUsage > 0 && e.tokenUsage != null
          ? (primary.costUsd * e.tokenUsage) / primary.tokenUsage
          : null;
      const cost = directCost ?? tokenCost;
      if (cost != null) r.costUsd = (r.costUsd ?? 0) + cost;

      for (const file of changedFilesByEventId.get(e.id)?.values() ?? []) {
        r.fileMap.set(file.id, file);
      }
    };

    for (const e of topEvents) {
      if (e.type !== "user_message") continue;
      rollups.set(e.id, {
        turn: turnNumberByEventId.get(e.id) ?? 0,
        steps: 0,
        edits: 0,
        bash: 0,
        errors: 0,
        tokens: 0,
        durationMs: 0,
        wallDurationMs: 0,
        costUsd: null,
        fileMap: new Map(),
        summary: firstNonEmptyLine(e.body) || e.title,
      });
    }

    for (const e of topEvents) {
      const headerId = turnHeaderIds.get(e.id);
      if (!headerId) continue;
      const r = rollups.get(headerId);
      if (!r) continue;
      if (e.id !== headerId) r.steps += 1;
      collect(r, e);
      for (const child of childrenByParent.get(e.id) ?? []) collect(r, child);
    }

    const sessionStart = hmsToMs(topEvents[0]?.ts ?? "") ?? 0;
    const normalizeMs = (e: TranscriptEvent | undefined) => {
      const raw = e ? hmsToMs(e.ts) : null;
      if (raw == null) return sessionStart;
      return raw < sessionStart ? raw + DAY_MS : raw;
    };
    const headers = topEvents.filter((e) => e.type === "user_message");
    const lastTop = topEvents.at(-1);
    for (let i = 0; i < headers.length; i += 1) {
      const start = normalizeMs(headers[i]);
      const end = i + 1 < headers.length ? normalizeMs(headers[i + 1]) : normalizeMs(lastTop);
      const r = rollups.get(headers[i].id);
      if (r) r.wallDurationMs = Math.max(0, end - start);
    }

    const out = new Map<string, Omit<TurnRollup, "collapsed">>();
    for (const [headerId, r] of rollups) {
      const { fileMap, ...rest } = r;
      out.set(headerId, { ...rest, files: [...fileMap.values()] });
    }
    return out;
  }, [
    changedFilesByEventId,
    childrenByParent,
    primary.costUsd,
    primary.tokenUsage,
    topEvents,
    turnHeaderIds,
    turnNumberByEventId,
  ]);

  const highestTurnJump = useMemo(() => {
    let best: { headerId: string; turn: number; score: number; basis: "cost" | "duration" } | null = null;
    const useCostBasis =
      primary.runner === "claude-code" &&
      [...turnRollups.values()].some((r) => r.costUsd != null && Number.isFinite(r.costUsd));
    for (const [headerId, r] of turnRollups.entries()) {
      const costScore = r.costUsd ?? -1;
      const durationScore = r.wallDurationMs > 0 ? r.wallDurationMs : r.durationMs;
      const basis: "cost" | "duration" = useCostBasis ? "cost" : "duration";
      const score = basis === "cost" ? costScore : durationScore;
      if (score < 0) continue;
      if (!best || score > best.score || (score === best.score && r.turn < best.turn)) {
        best = { headerId, turn: r.turn, score, basis };
      }
    }
    return best;
  }, [primary.runner, turnRollups]);

  const firstErrorTurnJump = useMemo(() => {
    for (const [headerId, r] of [...turnRollups.entries()].sort((a, b) => a[1].turn - b[1].turn)) {
      if (r.errors > 0) return { headerId, turn: r.turn, errors: r.errors };
    }
    return null;
  }, [turnRollups]);

  const eventTimeBars = useMemo(() => {
    const parsedTop = topEvents.map((e) => hmsToMs(e.ts)).filter((n): n is number => n != null);
    const start = parsedTop[0] ?? 0;
    const lastRaw = parsedTop.at(-1) ?? start;
    const last = lastRaw < start ? lastRaw + DAY_MS : lastRaw;
    const span = Math.max(1, primary.durationMs ?? Math.max(1, last - start));
    const m = new Map<string, { startPct: number; widthPct: number }>();
    for (const e of events) {
      const raw = hmsToMs(e.ts);
      const eventMs = raw == null ? start : raw < start ? raw + DAY_MS : raw;
      const duration = Math.max(0, e.durationMs ?? 0);
      const startPct = clampPct(((eventMs - start) / span) * 100);
      const widthPct = duration > 0 ? Math.max(0.7, Math.min(100, (duration / span) * 100)) : 0.35;
      m.set(e.id, { startPct, widthPct });
    }
    return m;
  }, [events, primary.durationMs, topEvents]);

  const selected: TranscriptEvent | undefined = useMemo(
    () => events.find((e) => e.id === selectedEventId),
    [events, selectedEventId]
  );
  const selectedFiles = selected ? bundle.eventFiles[selected.id] ?? [] : [];

  // ---- aside scoping while a sub-agent run is open ------------------------
  // On the Subagents tab, opening a run sets selectedEventId = launcher id so the
  // EXECUTION list highlights its own header. But the right aside then mirrored
  // the launcher's own detail — a near-duplicate of the centre stats strip +
  // RESULT·SUMMARY. While a run is open, the aside is reserved for the EXECUTION
  // *step* the user picks; if nothing is picked yet (selection is still the
  // launcher), show a quiet placeholder instead of re-printing the run.
  const asideIsLauncherDup =
    activeTab === "subagents" &&
    subAgentTab !== "overview" &&
    selectedEventId === subAgentTab;

  // ---- metrics band derived values (REAL data) ----------------------------
  const branch = primary.gitBranch ?? "main";
  const commitLabel = `${primary.commitCount} commit${primary.commitCount === 1 ? "" : "s"}`;

  // ---- minimap density buckets (deterministic from data) ------------------
  // Bucket events along the run and size each tick by the bucket's event count,
  // so bar heights are derived from data (not random / index math).
  const minimapTicks = useMemo(() => {
    const N = events.length;
    if (N === 0) return [] as { kind: string; h: number; id: string; ts: string; title: string }[];
    const buckets = Math.min(N, Math.max(12, Math.round(48 * zoom)));
    const counts = new Array(buckets).fill(0);
    events.forEach((_, i) => {
      const b = Math.min(buckets - 1, Math.floor((i / N) * buckets));
      counts[b] += 1;
    });
    const maxCount = Math.max(1, ...counts);
    return events.map((e, i) => {
      const b = Math.min(buckets - 1, Math.floor((i / N) * buckets));
      // height scales with local density; errors always tall so they stand out.
      const base = 10 + (counts[b] / maxCount) * 24;
      const h = e.type === "error" ? 34 : Math.round(base);
      return { kind: minimapKind(e.type), h, id: e.id, ts: e.ts, title: e.title };
    });
  }, [events, zoom]);

  // Playhead/window position from the selected event's index along the run.
  const selIndex = useMemo(
    () => events.findIndex((e) => e.id === selectedEventId),
    [events, selectedEventId]
  );
  const playPct = events.length > 1 ? (Math.max(0, selIndex) / (events.length - 1)) * 100 : 50;

  // ---- detail metadata for the selected event ----------------------------
  const selType = (selected?.type ?? "bash") as EventType;
  const sessionDate = parseStamp(primary.startedAt).date;
  const selTime = selected ? selected.ts.slice(0, 8) : "";
  // tool-call count (sub-agents) parsed from meta; tool name for the label
  const selMeta: { tool?: string; toolUses?: number } = (() => {
    try {
      return selected?.meta ? JSON.parse(selected.meta) : {};
    } catch {
      return {};
    }
  })();
  const fmtDur2 = (ms: number | null): string =>
    ms == null ? "—" : ms < 1000 ? `${ms}ms` : humanizeDuration(ms);
  const selStatusClass =
    selected?.exitCode == null ? "neutral" : selected.exitCode === 0 ? "success" : "failed";
  const selStatusText =
    selected?.exitCode == null ? "Done" : selected.exitCode === 0 ? "Success" : "Failed";
  const selPinned = selected ? pins.has(selected.id) : false;
  const selNote = selected ? notes[selected.id] : undefined;

  const runJson: Record<string, unknown> = selected
    ? {
        id: selected.id,
        seq: selected.seq,
        type: selected.type,
        actor: selected.actor,
        ts: selected.ts,
        command: selected.command,
        exit_code: selected.exitCode,
        duration_ms: selected.durationMs,
      }
    : {};

  const pendingFindingsCount = useMemo(
    () => findings.filter((finding) => !finding.verdict).length,
    [findings],
  );
  const currentSessionFindings = useMemo(
    () => findings.filter((finding) => findingTouchesSession(finding, currentId)),
    [currentId, findings],
  );
  const currentSessionPendingFindings = useMemo(
    () => currentSessionFindings.filter((finding) => !finding.verdict),
    [currentSessionFindings],
  );
  const visibleFindings = useMemo(() => {
    return findings
      .filter((finding) => {
        if (findingStatusFilter === "pending" && finding.verdict) return false;
        if (findingStatusFilter === "decided" && !finding.verdict) return false;
        if (findingSessionFilter !== "all" && !findingTouchesSession(finding, findingSessionFilter)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (!a.verdict && b.verdict) return -1;
        if (a.verdict && !b.verdict) return 1;
        return b.confidence - a.confidence || b.id - a.id;
      });
  }, [findingSessionFilter, findingStatusFilter, findings]);

  // the finding open in the detail panel — defaults to (and stays valid within)
  // the current visible list. When the list changes (filter / new data) and the
  // selection falls out of view, fall back to the first visible finding.
  const selectedFinding = useMemo(() => {
    if (selectedFindingId == null) return visibleFindings[0] ?? null;
    return (
      visibleFindings.find((finding) => finding.id === selectedFindingId) ??
      visibleFindings[0] ??
      null
    );
  }, [selectedFindingId, visibleFindings]);
  useEffect(() => {
    if (activeTab !== "findings") return;
    if (selectedFinding && selectedFinding.id !== selectedFindingId) {
      setSelectedFindingId(selectedFinding.id);
    }
  }, [activeTab, selectedFinding, selectedFindingId]);

  const eventById = useMemo(() => {
    const map = new Map<string, TranscriptEvent>();
    for (const event of events) map.set(event.id, event);
    return map;
  }, [events]);

  const eventBySeq = useMemo(() => {
    const map = new Map<number, TranscriptEvent>();
    for (const event of events) {
      if (!event.parentId && !map.has(event.seq)) map.set(event.seq, event);
      if (!map.has(event.seq)) map.set(event.seq, event);
    }
    return map;
  }, [events]);

  // seq deep link (cross-session evidence jump): once the requested session's
  // bundle is loaded, open the transcript, expand the owning turn, select the
  // step at that seq and flash it. Re-runs only when the session or seq changes.
  useEffect(() => {
    if (initialSeq == null) return;
    const target = eventBySeq.get(initialSeq);
    if (!target) return;
    setActiveTab("transcript");
    expandTurnForEvent(target.id);
    setSelectedEventId(target.id);
    flashStep(target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary.id, initialSeq, eventBySeq]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const hunkTargetById = useMemo(() => {
    const map = new Map<string, { fileId: string; hunkId: string; hunkSeq: number; path: string }>();
    for (const file of bundle.changedFiles) {
      for (const hunk of bundle.hunks[file.id] ?? []) {
        map.set(hunk.id, { fileId: file.id, hunkId: hunk.id, hunkSeq: hunk.seq, path: file.path });
      }
    }
    return map;
  }, [bundle.changedFiles, bundle.hunks]);

  function resolveEvidence(evidence: FindingEvidence):
    | { resolved: true; kind: FindingEvidence["subjectKind"]; label: string; title: string; jump: () => void }
    | { resolved: false; kind: FindingEvidence["subjectKind"]; label: string; title: string } {
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

    // event AND turn evidence both point at one transcript step. The analyst
    // (analyst-engine.ts) writes turn evidence as { subjectKind:"turn",
    // locator:{ seq } } where `seq` is the EVENT seq — NOT a turn number. So both
    // kinds resolve through the same locator: subject_id (event id) OR seq.
    // (Historical fixtures may carry an actual turn number under `turn`; keep
    // that as a fallback so they still resolve.)
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
      // same-session turn-number fallback (only meaningful for `turn` evidence
      // that carries a real turn number rather than an event seq).
      if (evidence.subjectKind === "turn") {
        const turn = locatorNumber(evidence, ["turn", "turn_number", "turnNumber"]);
        const headerId =
          turn == null
            ? null
            : [...turnNumberByEventId.entries()].find(([, value]) => value === turn)?.[0] ?? null;
        if (sameSession && headerId) {
          return {
            resolved: true,
            kind: "turn",
            label: `turn ${turn}`,
            title: `Turn ${turn}`,
            jump: () => jumpToTurn(headerId),
          };
        }
      }
      if (targetSessionId && targetSessionId !== currentId) {
        // deep link into the other session's transcript at the same seq; the
        // destination scrolls + flashes that step (see the seq deep-link effect).
        const seqParam = seq != null ? `&seq=${seq}` : "";
        return {
          resolved: true,
          kind: evidence.subjectKind,
          label: seq != null ? `step ${seq} ↗` : "step ↗",
          title: targetSessionId,
          jump: () =>
            router.push(
              `/?session=${encodeURIComponent(targetSessionId)}&tab=transcript${seqParam}`,
            ),
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
        ? primaryPrs.find((item) => item.id === prId)
        : prNumber != null
          ? primaryPrs.find((item) => item.number === prNumber)
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

    // Could not map the locator to anything in the current bundle / session
    // list. Mark it explicitly "未解決" — never echo the kind name as a label
    // (that read as a meaningless duplicate of the kind tag).
    return {
      resolved: false,
      kind: evidence.subjectKind,
      label: "未解決",
      title: evidence.note ?? "この根拠は現在のデータに解決できません",
    };
  }

  // ---- handlers ------------------------------------------------------------
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

  function flashStep(eventId: string) {
    setFlashEventId(eventId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashEventId(null), 2200);
  }

  function selectTimelineEvent(eventId: string, expandTurn = false) {
    if (expandTurn) expandTurnForEvent(eventId);
    setSelectedEventId(eventId);
    flashStep(eventId);
  }

  function jumpToTurn(headerId: string) {
    setActiveTab("transcript");
    expandTurnForEvent(headerId);
    setSelectedEventId(headerId);
  }

  function openTurnFile(fileId: string) {
    setGitFocusFileId(fileId);
    setGitFocusEvent(undefined);
    setGitFocusHunkId(undefined);
    setActiveTab("git");
  }

  function switchSession(id: string) {
    if (id === currentId) return;
    // preserve the current tab so switching sessions from the sidebar keeps you
    // where you are (e.g. stay on the Git tab while comparing sessions).
    router.push(`/?session=${encodeURIComponent(id)}&tab=${activeTab}`);
  }

  // Open one sub-agent run's detail tab and surface its summary on the right.
  function openAgent(launcherId: string) {
    setSubAgentTab(launcherId);
    setSelectedEventId(launcherId);
  }

  function toggleType(t: EventType) {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function clearFilters() {
    setTypeFilter(new Set(ALL_TYPES));
    setFilterMode("hide");
    setSessionSearch("");
    setTranscriptSearch("");
  }

  function togglePin() {
    if (!selected) return;
    const next = new Set(pins);
    if (next.has(selected.id)) next.delete(selected.id);
    else next.add(selected.id);
    persistPins(next);
  }

  function openNoteEditor() {
    if (!selected) return;
    setNoteDraft(notes[selected.id] ?? "");
  }
  function saveNote() {
    if (!selected || noteDraft == null) return;
    const next = { ...notes };
    const trimmed = noteDraft.trim();
    if (trimmed) next[selected.id] = trimmed;
    else delete next[selected.id];
    persistNotes(next);
    setNoteDraft(null);
  }

  function selectNearestTick(clientX: number, trackEl: HTMLElement) {
    if (events.length === 0) return;
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.min(events.length - 1, Math.round(ratio * (events.length - 1)));
    selectTimelineEvent(events[idx].id, true);
  }

  function prStateLabel(pr: PullRequestSummary): string {
    if (pr.mergedAt || pr.state === "merged") return "merged";
    return pr.state;
  }

  function openPr(prId: string) {
    router.push(`/pr?pr=${encodeURIComponent(prId)}`);
  }

  async function submitFindingVerdict(finding: Finding, verdict: FindingVerdictValue) {
    if (findingBusy[finding.id]) return;
    setFindingError(null);
    setFindingBusy((prev) => ({ ...prev, [finding.id]: true }));
    try {
      const response = await fetch(`/api/findings/${finding.id}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict,
          reason: findingReasonDrafts[finding.id] ?? "",
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; verdict?: FindingVerdict; error?: string };
      if (!response.ok || !payload.ok || !payload.verdict) {
        throw new Error(payload.error ?? "verdict failed");
      }
      setFindings((prev) =>
        prev.map((item) => (item.id === finding.id ? { ...item, verdict: payload.verdict! } : item)),
      );
      setFindingReasonDrafts((prev) => ({ ...prev, [finding.id]: "" }));
      setRecentFindingVerdict({
        findingId: finding.id,
        verdictId: payload.verdict.id,
        verdict,
        title: finding.title,
      });
    } catch (error) {
      setFindingError((error as Error).message);
    } finally {
      setFindingBusy((prev) => ({ ...prev, [finding.id]: false }));
    }
  }

  async function undoFindingVerdict() {
    if (!recentFindingVerdict) return;
    const recent = recentFindingVerdict;
    setFindingError(null);
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
      setRecentFindingVerdict(null);
    } catch (error) {
      setFindingError((error as Error).message);
    }
  }

  function openCurrentSessionFindings() {
    setFindingSessionFilter(currentId);
    setActiveTab("findings");
    router.push(`/?session=${encodeURIComponent(currentId)}&tab=findings&findingSession=${encodeURIComponent(currentId)}`);
  }

  function findingDiscussHref(finding: Finding): string {
    const sessionId =
      finding.evidence.map(evidenceSessionId).find((id): id is string => Boolean(id)) ?? currentId;
    return `/chat?finding=${finding.id}&session=${encodeURIComponent(sessionId)}`;
  }

  return (
    <>
      {/* ===================== Band 2 — metrics ===================== */}
      <div className="sessbar">
        <div className="sessbar-id">
          <span className={`runner-dot ${primary.runner}`} aria-hidden />
          <span className="sessbar-title" title={primary.title}>
            {primary.title}
          </span>
          {primary.errorCount > 0 && (
            <span
              className="badge err"
              title={`${primary.errorCount} tool call(s) returned a non-zero exit (incl. sub-agents). Not a session-level verdict.`}
            >
              {primary.errorCount} error{primary.errorCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="sessbar-meta">
            {primary.model ?? "—"} · <span className="mono">⎇ {branch}</span> · {commitLabel} ·{" "}
            {sessionDate} {parseStamp(primary.startedAt).time}
          </span>
          <CostAnomalyChip session={primary} />
          {currentSessionFindings.length > 0 && (
            <button
              type="button"
              className="chip jump-chip findings-session-chip"
              data-finding-session-count={currentSessionFindings.length}
              data-finding-session-pending={currentSessionPendingFindings.length}
              title="Show findings attached to this session"
              onClick={openCurrentSessionFindings}
            >
              {currentSessionFindings.length} finding{currentSessionFindings.length === 1 ? "" : "s"}
              {currentSessionPendingFindings.length > 0 && (
                <span className="chip-sub mono">{currentSessionPendingFindings.length} pending</span>
              )}
            </button>
          )}
          <Link
            href={`/chat?session=${encodeURIComponent(currentId)}`}
            className="chip jump-chip chat-session-chip"
            title="Discuss this session"
          >
            Discuss
          </Link>
          <span className="sessbar-jumps">
            {highestTurnJump && (
              <button
                type="button"
                className="chip jump-chip high-turn-chip"
                data-jump-kind="highest-cost-turn"
                data-turn={highestTurnJump.turn}
                data-turn-score-basis={highestTurnJump.basis}
                title={
                  highestTurnJump.basis === "cost"
                    ? `Jump to the highest estimated-cost turn (${fmtCost(highestTurnJump.score)})`
                    : `Jump to the longest-duration turn (${humanizeDuration(highestTurnJump.score)})`
                }
                onClick={() => jumpToTurn(highestTurnJump.headerId)}
              >
                最も高い turn へ
              </button>
            )}
            {firstErrorTurnJump && (
              <button
                type="button"
                className="chip jump-chip error-turn-chip"
                data-jump-kind="error-turn"
                data-turn={firstErrorTurnJump.turn}
                title={`Jump to turn ${firstErrorTurnJump.turn} with ${firstErrorTurnJump.errors} error(s)`}
                onClick={() => jumpToTurn(firstErrorTurnJump.headerId)}
              >
                エラー turn へ
              </button>
            )}
          </span>
          {primaryPrs.length > 0 && (
            <span className="pr-chip-row">
              {primaryPrs.slice(0, 3).map((pr) => (
                <Link
                  key={pr.id}
                  href={`/pr?pr=${encodeURIComponent(pr.id)}`}
                  className={`pr-chip ${prStateLabel(pr)}`}
                  title={pr.title}
                >
                  #{pr.number} {prStateLabel(pr)}
                </Link>
              ))}
            </span>
          )}
        </div>
        <div className="sessbar-stats">
          <div className="kstat">
            <b>{humanizeDuration(primary.durationMs)}</b>
            <span>duration</span>
          </div>
          <div className="kstat">
            <b>{fmtInt(primary.turnCount)}</b>
            <span>turns</span>
          </div>
          <div className="kstat">
            <b>{fmtInt(primary.toolCount)}</b>
            <span>tools</span>
          </div>
          <div className="kstat">
            <b>{fmtInt(primary.editCount)}</b>
            <span>edits</span>
          </div>
          <div
            className="kstat"
            title={`${fmtInt(primary.tokenIn)} in · ${fmtInt(primary.tokenOut)} out`}
          >
            <b>{fmtCompact(primary.tokenUsage)}</b>
            <span>tokens</span>
          </div>
          <div
            className="kstat"
            title="Estimated cost = real token usage × model pricing (input/output/cache-write/cache-read, per db/pricing.json). Sub-agent tokens not included; '—' when the model isn't priceable."
          >
            <b>{fmtCost(primary.costUsd)}</b>
            <span>cost</span>
          </div>
        </div>
      </div>

      {/* ===================== Band 3 — tabs ===================== */}
      <div className="tabs">
        {(
          [
            ["transcript", "Transcript"],
            ["tools", "Tools"],
            ["git", "Git"],
            ["skills", "Skills"],
            ["subagents", "Subagents"],
            ["annotations", "Annotations"],
            ["findings", "Findings"],
            ["raw", "Raw JSON"],
            ["stats", "Stats"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab${activeTab === key ? " active" : ""}`}
            onClick={() => {
              setActiveTab(key);
              if (key === "git") {
                setGitFocusEvent(undefined);
                setGitFocusFileId(undefined);
                setGitFocusHunkId(undefined);
              }
            }}
          >
            {label}
            {key === "annotations" && annotations.length > 0 && (
              <span className="tab-count">{annotations.length}</span>
            )}
            {key === "findings" && pendingFindingsCount > 0 && (
              <span className="tab-count">{pendingFindingsCount}</span>
            )}
          </button>
        ))}
        <Link href="/chat" className="tab">
          Chat
        </Link>
        <span className="tabs-spacer" />
        <span className="tabs-tool">
          <span className="sort-select">{visibleEvents.length} shown</span>
        </span>
      </div>

      {/* ===================== Band 4 — 3-col layout ===================== */}
      {/* Findings is a self-contained master-detail screen: the run/event
          inspector on the right has no bearing on accept/reject, so we drop the
          aside column entirely and give its width to the findings detail. */}
      <div
        className="layout3"
        data-tab={activeTab}
        style={{
          gridTemplateColumns:
            activeTab === "findings"
              ? "var(--sidebar-w) minmax(0,1fr)"
              : "var(--sidebar-w) minmax(0,1fr) var(--aside-w)",
        }}
      >
        {/* ---------- COLUMN 1: sidebar ---------- */}
        <aside className="sidebar">
          <Link href="/overview" className="overview-link" title="Project-/all-projects-level analytics">
            <span>Overview</span>
            <span className="muted small" style={{ marginLeft: "auto" }}>cross-session →</span>
          </Link>
          <div className="project-select">
            <span aria-hidden>⊞</span>
            <select
              className="project-picker"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              title="Scope the session list to one project"
            >
              <option value="all">All projects · {sessions.length} sessions</option>
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.project} · {p.sessions} ses · {p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}
                </option>
              ))}
            </select>
          </div>

          <div className="search">
            <span aria-hidden>⌕</span>
            <input
              placeholder="Search sessions…"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
            />
            <span className="kbd">⌘K</span>
          </div>

          <div className="filters">
            <div className="filters-head">
              <span className="title">Filters</span>
              <button type="button" className="clear" onClick={clearFilters}>
                Clear
              </button>
            </div>

            <div className="filter-row">
              <span className="flabel">Event types</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                {ALL_TYPES.map((t) => {
                  const on = typeFilter.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`event-type-badge ${t}`}
                      title={`${EVENT_LABEL[t]} — click to ${on ? "hide" : "show"}`}
                      onClick={() => toggleType(t)}
                      style={{
                        cursor: "pointer",
                        opacity: on ? 1 : 0.38,
                      }}
                    >
                      {EVENT_LABEL[t]}
                      <span className="mono" style={{ marginLeft: "auto", color: "var(--muted-2)" }}>
                        {typeCounts[t] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="filter-row">
              <span className="flabel">Type filter mode</span>
              <span className="segmented filter-mode" title="Choose whether non-matching event types stay visible or are hidden">
                <button
                  type="button"
                  className={filterMode === "highlight" ? "active" : ""}
                  onClick={() => setFilterMode("highlight")}
                >
                  Highlight
                </button>
                <button
                  type="button"
                  className={filterMode === "hide" ? "active" : ""}
                  onClick={() => setFilterMode("hide")}
                >
                  Hide
                </button>
              </span>
            </div>

            <div className="filter-row">
              <span className="flabel">Model</span>
              <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
                <option value="all">All models</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-row">
              <span className="flabel">Errors</span>
              <select value={errorsFilter} onChange={(e) => setErrorsFilter(e.target.value)}>
                <option value="any">Any</option>
                <option value="yes">With errors</option>
                <option value="no">Clean (0 errors)</option>
              </select>
            </div>
          </div>

          <div className="session-head">
            <span>
              <span className="title">Sessions</span>
              <span className="count">{visibleSessions.length}</span>
            </span>
            <select
              className="sort-select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="recent">Recent first</option>
              <option value="oldest">Oldest first</option>
              <option value="tokens">Most tokens</option>
            </select>
          </div>

          <div className="sidebar-scroll">
            <div className="session-list">
              {visibleSessions.map((s) => {
                const st = parseStamp(s.startedAt);
                const active = s.id === currentId;
                const prs = sessionPrs[s.id] ?? [];
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-session-id={s.id}
                    className={`session-item${active ? " active" : ""}`}
                    onClick={() => switchSession(s.id)}
                    style={{ textAlign: "left", width: "100%", font: "inherit" }}
                  >
                    <div className="si-top">
                      <span className="si-title">{s.title}</span>
                      <span className="si-flags">
                        <CostAnomalyChip session={s} />
                        {s.errorCount > 0 && (
                          <span className="badge err" title={`${s.errorCount} failed tool call(s)`}>
                            {s.errorCount} err
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="si-meta">
                      <span>
                        {st.date}, {st.time}
                      </span>
                      <span className="dot">·</span>
                      <span>{humanizeDuration(s.durationMs)}</span>
                      <span className="dot">·</span>
                      <span>{s.model ?? "—"}</span>
                    </div>
                    <div className="si-stats">
                      <span className="runner-badge">
                        <span className={`runner-dot ${s.runner}`} />
                        {RUNNER_LABEL[s.runner]}
                      </span>
                      <span className="chip token">{fmtTok(s.tokenUsage)} tok</span>
                      <span className="chip cost">{fmtCost(s.costUsd)}</span>
                      {prs.slice(0, 1).map((pr) => (
                        <span
                          key={pr.id}
                          className={`pr-chip mini ${prStateLabel(pr)}`}
                          title={pr.title}
                          role="link"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            openPr(pr.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              openPr(pr.id);
                            }
                          }}
                        >
                          #{pr.number} {prStateLabel(pr)}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
              {visibleSessions.length === 0 && (
                <div className="empty" style={{ padding: "12px" }}>
                  No sessions match.
                </div>
              )}
            </div>
          </div>

          <div className="user-footer">
            <span className="avatar">YO</span>
            <span className="uname">Yutaro Ono</span>
            <span className="badge pro">Pro</span>
            <span className="gear" aria-label="Settings">
              ⚙
            </span>
          </div>
        </aside>

        {/* The "Git" tab is an in-page tab like every other one: the session
            list above stays put, and only the centre+right swap to the diff.
            (It used to navigate to a separate /diff page that replaced the whole
            sidebar — losing session navigation. Now the diff is embedded here.) */}
        {activeTab === "git" ? (
          <DiffViewer
            embedded
            sessions={sessions}
            bundle={bundle}
            currentId={currentId}
            focusEventId={gitFocusEvent}
            focusFileId={gitFocusFileId}
            focusHunkId={gitFocusHunkId}
            onJumpToEvent={(eid) => {
              setActiveTab("transcript");
              selectTimelineEvent(eid, true);
              setGitFocusEvent(undefined);
              setGitFocusFileId(undefined);
              setGitFocusHunkId(undefined);
            }}
          />
        ) : activeTab === "stats" ? (
          <SessionStatsView bundle={bundle} />
        ) : (
          <>
        {/* ---------- COLUMN 2: main / timeline ---------- */}
        <main className="main">
          {/* transcript search lives above the timeline (only for transcript tab) */}
          {activeTab === "transcript" && (
            <div
              className="transcript-toolbar"
              style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 12px 6px" }}
            >
              <div className="search" style={{ flex: "1 1 auto" }}>
                <span aria-hidden>⌕</span>
                <input
                  placeholder="Filter timeline…"
                  value={transcriptSearch}
                  onChange={(e) => setTranscriptSearch(e.target.value)}
                />
              </div>
              {turnCount > 1 && (
                <span className="segmented turn-filter" title="Show/hide every turn in this session">
                  <button
                    type="button"
                    className={collapsedTurns.size === 0 ? "active" : ""}
                    onClick={expandAllTurns}
                  >
                    Expand turns
                  </button>
                  <button
                    type="button"
                    className={collapsedTurns.size === turnCount ? "active" : ""}
                    onClick={collapseAllTurns}
                  >
                    Collapse turns
                  </button>
                </span>
              )}
            </div>
          )}

          {/* ===== TRANSCRIPT (timeline) ===== */}
          {activeTab === "transcript" && (
            <div className="timeline">
              {(() => {
                const renderRow = (
                  e: TranscriptEvent,
                  depth: number,
                  childCount: number,
                  turnStats?: TurnRollup,
                ) => {
                  const isSel = selectedEventId === e.id;
                  const glyph = TYPE_GLYPH[e.type] ?? "•";
                  const pinned = pins.has(e.id);
                  const expanded = expandedAgents.has(e.id);
                  const isTurnHeader = turnStats != null;
                  const ownerHeaderId = turnHeaderIds.get(e.id);
                  const ownerTurn = isTurnHeader
                    ? turnStats.turn
                    : ownerHeaderId
                      ? turnRollups.get(ownerHeaderId)?.turn
                      : undefined;
                  const rollupDurationMs =
                    isTurnHeader && turnStats.durationMs > 0
                      ? turnStats.durationMs
                      : isTurnHeader
                        ? turnStats.wallDurationMs
                        : 0;
                  const isDimmed = filterMode === "highlight" && !matchesType(e);
                  const timebar = eventTimeBars.get(e.id) ?? { startPct: 0, widthPct: 0.35 };
                  let subNode: React.ReactNode = null;
                  if (isTurnHeader) {
                    subNode = <div className="event-sub body turn-summary">{turnStats.summary}</div>;
                  } else if (e.filePath) subNode = <div className="event-sub path">{e.filePath}</div>;
                  else if (e.command) subNode = <div className="event-sub mono">{e.command}</div>;
                  else if (e.body)
                    subNode = <div className="event-sub body">{e.body.split("\n")[0]}</div>;
                  const showBadge =
                    e.type === "subagent" ||
                    e.type === "skill" ||
                    e.type === "error" ||
                    e.type === "commit" ||
                    e.type === "thinking" ||
                    e.type === "memory" ||
                    e.type === "hook";
                  return (
                    <div
                      key={e.id}
                      data-eid={e.id}
                      data-filter-match={isDimmed ? "false" : "true"}
                      data-turn={ownerTurn}
                      data-rollup-steps={isTurnHeader ? turnStats.steps : undefined}
                      data-rollup-edits={isTurnHeader ? turnStats.edits : undefined}
                      data-rollup-errors={isTurnHeader ? turnStats.errors : undefined}
                      data-rollup-files={isTurnHeader ? turnStats.files.length : undefined}
                      data-rollup-duration-ms={isTurnHeader ? rollupDurationMs : undefined}
                      data-turn-has-error={isTurnHeader && turnStats.errors > 0 ? "true" : undefined}
                      data-flash={flashEventId === e.id ? "true" : undefined}
                      className={`event-row${depth > 0 ? " child-row" : ""}${!isTurnHeader ? " step-row" : ""}${isSel ? " selected" : ""}${flashEventId === e.id ? " flash-jump" : ""}${isTurnHeader ? " turn-header" : ""}${isTurnHeader && turnStats.errors > 0 ? " turn-has-error" : ""}${isDimmed ? " filter-dimmed" : ""}`}
                      onClick={() => {
                        if (isTurnHeader) {
                          setSelectedEventId(e.id);
                          toggleTurn(e.id);
                        } else {
                          selectTimelineEvent(e.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          if (isTurnHeader) {
                            setSelectedEventId(e.id);
                            toggleTurn(e.id);
                          } else {
                            selectTimelineEvent(e.id);
                          }
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="event-seq">
                        {isTurnHeader ? (
                          <button
                            type="button"
                            className="tw-expand"
                            aria-label={turnStats.collapsed ? "Expand turn" : "Collapse turn"}
                            title={turnStats.collapsed ? "Expand this turn" : "Collapse this turn"}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggleTurn(e.id);
                            }}
                          >
                            {turnStats.collapsed ? "▸" : "▾"}
                          </button>
                        ) : childCount > 0 ? (
                          <button
                            type="button"
                            className="tw-expand"
                            aria-label={expanded ? "Collapse sub-agent" : "Expand sub-agent"}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setExpandedAgents((prev) => {
                                const n = new Set(prev);
                                if (n.has(e.id)) n.delete(e.id);
                                else n.add(e.id);
                                return n;
                              });
                            }}
                          >
                            {expanded ? "▾" : "▸"}
                          </button>
                        ) : depth > 0 ? (
                          ""
                        ) : (
                          e.seq
                        )}
                      </span>
                      <span className="event-gutter">{e.ts}</span>
                      <span className={`event-icon ${e.type}`} aria-hidden>
                        {glyph}
                      </span>
                      <div className="event-main">
                        <div className="event-headline">
                          <span className="event-title">{e.title}</span>
                          {pinned && <span title="Pinned" aria-label="Pinned">📌</span>}
                          {notes[e.id] && <span title="Has note" aria-label="Has note">🗒</span>}
                          {showBadge && (
                            <span className={`event-type-badge ${e.type}`}>{EVENT_LABEL[e.type]}</span>
                          )}
                          {depth === 0 && e.subagent && (
                            <span className="event-type-badge subagent">{e.subagent}</span>
                          )}
                        </div>
                        {subNode}
                      </div>
                      <span className="event-meta">
                        {isTurnHeader && (
                          <span className="chip turn-chip" title={`Turn ${turnStats.turn} of ${turnCount}`}>
                            Turn {turnStats.turn}
                          </span>
                        )}
                        {isTurnHeader && (
                          <>
                            <span className="chip rollup-chip" data-rollup-kind="steps">
                              {turnStats.steps} step{turnStats.steps === 1 ? "" : "s"}
                            </span>
                            <span className="chip rollup-chip" data-rollup-kind="edits">
                              {turnStats.edits} edits
                            </span>
                            <span className="chip rollup-chip" data-rollup-kind="bash">
                              {turnStats.bash} bash
                            </span>
                            <span
                              className={`chip rollup-chip${turnStats.errors > 0 ? " err" : ""}`}
                              data-rollup-kind="errors"
                            >
                              {turnStats.errors} errors
                            </span>
                            <span className="chip rollup-chip" data-rollup-kind="cost">
                              {fmtCost(turnStats.costUsd)}
                            </span>
                            <span className="chip rollup-chip" data-rollup-kind="tokens">
                              {fmtCompact(turnStats.tokens)} tok
                            </span>
                            <span className="chip rollup-chip" data-rollup-kind="duration">
                              {humanizeDuration(rollupDurationMs)}
                            </span>
                            {turnStats.files.length > 0 ? (
                              <button
                                type="button"
                                className="chip rollup-chip turn-files-chip"
                                data-file-id={turnStats.files[0].id}
                                title={turnStats.files.map((f) => f.path).join("\n")}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  openTurnFile(turnStats.files[0].id);
                                }}
                              >
                                {turnStats.files.length} files
                              </button>
                            ) : (
                              <span className="chip rollup-chip is-empty" data-rollup-kind="files">
                                0 files
                              </span>
                            )}
                          </>
                        )}
                        {childCount > 0 && (
                          <span className="chip">{childCount} steps</span>
                        )}
                        {depth === 0 && e.type === "subagent" && (
                          <button
                            type="button"
                            className="sa-jump"
                            title="Open this run in the Subagents tab"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setActiveTab("subagents");
                              openAgent(e.id);
                            }}
                          >
                            ⌥ open →
                          </button>
                        )}
                        {e.type === "commit" && <span className="chip hash">{commitLabel}</span>}
                        {e.tokenUsage != null && <span className="tok">+{fmtInt(e.tokenUsage)} -0</span>}
                        {e.durationMs != null && <span className="dur">{durLabel(e.durationMs)}</span>}
                        {e.exitCode != null &&
                          (e.exitCode === 0 ? (
                            <span className="ok">✓</span>
                          ) : (
                            <span className="err">✗</span>
                          ))}
                        {!isTurnHeader && (
                          <span
                            className="step-timebar-track"
                            title={`time ${timebar.startPct.toFixed(1)}% · duration ${e.durationMs ?? 0}ms`}
                          >
                            <span
                              className="step-timebar"
                              data-start-pct={timebar.startPct.toFixed(3)}
                              data-width-pct={timebar.widthPct.toFixed(3)}
                              data-duration-ms={e.durationMs ?? 0}
                              style={{
                                left: `${timebar.startPct}%`,
                                width: `${timebar.widthPct}%`,
                              }}
                            />
                          </span>
                        )}
                      </span>
                    </div>
                  );
                };
                const rows: React.ReactNode[] = [];
                for (const e of visibleEvents) {
                  const header = turnHeaderIds.get(e.id);
                  const isHeader = e.type === "user_message" && turnNumberByEventId.has(e.id);
                  const collapsed = header != null && collapsedTurns.has(header);
                  // hide non-header rows whose owning turn is collapsed
                  if (collapsed && !isHeader) continue;
                  const kids = childrenByParent.get(e.id) ?? [];
                  const rollup = isHeader ? turnRollups.get(e.id) : undefined;
                  const turnStats = rollup ? { ...rollup, collapsed } : undefined;
                  rows.push(renderRow(e, 0, kids.length, turnStats));
                  if (!isHeader && kids.length && expandedAgents.has(e.id)) {
                    for (const k of kids) if (shouldRenderTimelineEvent(k)) rows.push(renderRow(k, 1, 0));
                  }
                }
                return rows;
              })()}
              {visibleEvents.length === 0 && (
                <div className="empty" style={{ padding: "16px" }}>
                  No events match the current filters.
                </div>
              )}
            </div>
          )}

          {/* ===== TOOLS ===== */}
          {activeTab === "tools" && (
            <div className="timeline">
              {events
                .filter((e) => TOOL_TYPES.includes(e.type))
                .map((e) => {
                  const isSel = selectedEventId === e.id;
                  return (
                    <div
                      key={e.id}
                      data-eid={e.id}
                      className={`event-row${isSel ? " selected" : ""}`}
                      onClick={() => setSelectedEventId(e.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSelectedEventId(e.id);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="event-seq">{e.seq}</span>
                      <span className="event-gutter">{e.ts}</span>
                      <span className={`event-icon ${e.type}`} aria-hidden>
                        {TYPE_GLYPH[e.type] ?? "•"}
                      </span>
                      <div className="event-main">
                        <div className="event-headline">
                          <span className="event-title">{e.title}</span>
                          <span className={`event-type-badge ${e.type}`}>{EVENT_LABEL[e.type]}</span>
                        </div>
                        {(e.command || e.filePath) && (
                          <div className={`event-sub ${e.filePath ? "path" : "mono"}`}>
                            {e.command ?? e.filePath}
                          </div>
                        )}
                      </div>
                      <span className="event-meta">
                        {e.durationMs != null && <span className="dur">{durLabel(e.durationMs)}</span>}
                        {e.exitCode != null &&
                          (e.exitCode === 0 ? (
                            <span className="ok">exit 0 ✓</span>
                          ) : (
                            <span className="err">exit {e.exitCode} ✗</span>
                          ))}
                      </span>
                    </div>
                  );
                })}
              {events.filter((e) => TOOL_TYPES.includes(e.type)).length === 0 && (
                <div className="empty" style={{ padding: "16px" }}>
                  No tool events.
                </div>
              )}
            </div>
          )}

          {/* ===== SKILLS ===== */}
          {activeTab === "skills" && (
            <div className="timeline">
              {events
                .filter((e) => e.type === "skill")
                .map((e) => {
                  const isSel = selectedEventId === e.id;
                  return (
                    <div
                      key={e.id}
                      data-eid={e.id}
                      className={`event-row${isSel ? " selected" : ""}`}
                      onClick={() => setSelectedEventId(e.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSelectedEventId(e.id);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="event-seq">{e.seq}</span>
                      <span className="event-gutter">{e.ts}</span>
                      <span className="event-icon skill" aria-hidden>
                        {TYPE_GLYPH.skill}
                      </span>
                      <div className="event-main">
                        <div className="event-headline">
                          <span className="event-title">{e.title}</span>
                          <span className="event-type-badge skill">Skill</span>
                        </div>
                        {e.body && <div className="event-sub body">{e.body.split("\n")[0]}</div>}
                      </div>
                      <span className="event-meta">
                        {e.durationMs != null && <span className="dur">{durLabel(e.durationMs)}</span>}
                      </span>
                    </div>
                  );
                })}
              {events.filter((e) => e.type === "skill").length === 0 && (
                <div className="empty" style={{ padding: "16px" }}>
                  No skill events.
                </div>
              )}
            </div>
          )}

          {/* ===== SUBAGENTS (per-run tabs + overview spine) ===== */}
          {activeTab === "subagents" && (
            <div className="sa-wrap">
              {invocations.length === 0 ? (
                <div className="timeline">
                  <div className="empty" style={{ padding: "16px" }}>
                    No sub-agent runs in this session.
                  </div>
                </div>
              ) : (
                <>
                  {/* sub-tab bar: Overview + one tab per distinct run */}
                  <div className="sa-tabbar" role="tablist" aria-label="Sub-agent runs">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={subAgentTab === "overview"}
                      className={`sa-tab${subAgentTab === "overview" ? " active" : ""}`}
                      onClick={() => setSubAgentTab("overview")}
                    >
                      ◇ Overview
                      <span className="sa-tab-count">{invocations.length}</span>
                    </button>
                    {invocations.map((inv, i) => {
                      const on = subAgentTab === inv.id;
                      const label = inv.subagent ?? "sub-agent";
                      return (
                        <button
                          key={inv.id}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          className={`sa-tab${on ? " active" : ""}`}
                          onClick={() => openAgent(inv.id)}
                          title={`Agent ${i + 1} · ${label}`}
                        >
                          <span className="sa-tab-idx">{i + 1}</span>
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="timeline">
                    {subAgentTab === "overview" ? (
                      /* ---------- OVERVIEW: chronological spine of every run ---------- */
                      invocations.map((e, i) => {
                        const { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools } = summarizeInvocation(e);
                        return (
                          <button
                            key={e.id}
                            type="button"
                            className="sa-card"
                            onClick={() => openAgent(e.id)}
                          >
                            <span className="sa-card-idx">{i + 1}</span>
                            <div className="sa-card-main">
                              <div className="sa-card-top">
                                <span className="event-type-badge subagent">⌥ {e.subagent ?? "sub-agent"}</span>
                                {model && <span className="sa-model" title="model the sub-agent ran on">{shortModel(model)}</span>}
                                <span className="sa-card-time">{e.ts}</span>
                                {runFailed && <span className="badge failed">error</span>}
                                {failedSteps > 0 && (
                                  <span
                                    className="chip failed-steps-chip"
                                    title={`${failedSteps} child step(s) exited non-zero — distinct from the run's own result`}
                                  >
                                    {failedSteps} failed step{failedSteps === 1 ? "" : "s"}
                                  </span>
                                )}
                              </div>
                              <div className="sa-card-task">{invocationSummaryLine(e)}</div>
                              {kids.length > 0 && (
                                <div className="sa-card-steps" aria-hidden>
                                  {kids.slice(0, 16).map((k) => (
                                    <span
                                      key={k.id}
                                      className={`sa-glyph ${k.type}`}
                                      title={`${EVENT_LABEL[k.type]} · ${k.title}`}
                                    >
                                      {TYPE_GLYPH[k.type] ?? "•"}
                                    </span>
                                  ))}
                                  {kids.length > 16 && <span className="sa-more">+{kids.length - 16}</span>}
                                </div>
                              )}
                            </div>
                            <span className="sa-card-meta">
                              <span className="chip">{kids.length} steps</span>
                              <span className="chip">{toolUses ?? observedTools} tools</span>
                              {e.durationMs != null && <span className="dur">{durLabel(e.durationMs)}</span>}
                              {(e.tokenUsage ?? tokens) != null && <span className="tok">{fmtTok((e.tokenUsage ?? tokens)!)} tok</span>}
                              {costUsd != null && <span className="sa-cost">{fmtCost(costUsd)}</span>}
                              <span className="sa-go">Open →</span>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      /* ---------- DETAIL: one run's full execution ---------- */
                      (() => {
                        const e = invocations.find((x) => x.id === subAgentTab);
                        if (!e) return null;
                        const { kids, toolUses, runFailed, failedSteps, model, costUsd, tokens, observedTools } = summarizeInvocation(e);
                        const tokensShown = e.tokenUsage ?? tokens ?? null;
                        return (
                          <div className="sa-detail">
                            {/* run selection / back / position all live in the .sa-tabbar above —
                                no second header row (it duplicated Overview, the active tab, and
                                tab-click navigation). Model sits in the stats strip below. */}
                            {/* fixed 7-column strip: every run shows the same cards so runs are
                                comparable at a glance. A missing value renders as "—" (not
                                recorded in the transcript), never by dropping the card — a
                                vanished "Tool calls" reads as "this model can't use tools". */}
                            <div className="sa-detail-stats">
                              <div className="stat">
                                <span className="stat-k">Steps</span>
                                <span className="stat-v">
                                  {kids.length}
                                  {failedSteps > 0 && (
                                    <span
                                      className="stat-note failed-steps-note"
                                      title={`${failedSteps} child step(s) exited non-zero — distinct from the run's own result`}
                                    >
                                      {failedSteps} failed
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="stat">
                                <span className="stat-k">Tool calls</span>
                                {toolUses != null ? (
                                  <span className="stat-v">{toolUses}</span>
                                ) : (
                                  <span
                                    className="stat-v"
                                    title="not reported by the run; counted from observed tool steps in the transcript"
                                  >
                                    {observedTools}
                                  </span>
                                )}
                              </div>
                              <div className="stat">
                                <span className="stat-k">Model</span>
                                <span className="stat-v" style={{ fontSize: "12.5px" }} title={model ?? "not recorded in the transcript"}>
                                  {model ? shortModel(model) : "—"}
                                </span>
                              </div>
                              <div className="stat">
                                <span className="stat-k">Duration</span>
                                <span className="stat-v" title={e.durationMs == null ? "not recorded in the transcript" : undefined}>
                                  {e.durationMs != null ? fmtDur2(e.durationMs) : "—"}
                                </span>
                              </div>
                              <div className="stat">
                                <span className="stat-k">Tokens</span>
                                <span
                                  className="stat-v"
                                  title={
                                    e.tokenUsage != null
                                      ? undefined
                                      : tokensShown != null
                                        ? "summed from the sub-agent's own transcript (cache reads excluded) — the same usage its cost is priced from"
                                        : "no usage recorded in either transcript"
                                  }
                                >
                                  {tokensShown != null ? fmtInt(tokensShown) : "—"}
                                </span>
                              </div>
                              <div className="stat">
                                <span className="stat-k">Cost</span>
                                <span className="stat-v" title={costUsd == null ? "model or token usage not recorded — cost is not invented" : undefined}>
                                  {costUsd != null ? fmtCost(costUsd) : "—"}
                                </span>
                              </div>
                              <div className="stat">
                                <span className="stat-k">Result</span>
                                <span
                                  className={`stat-v ${runFailed ? "err" : "ok"}`}
                                  title="The run's own verdict (the launcher's is_error / exit). Child-step failures are reported separately under Steps."
                                >
                                  {runFailed ? "error" : "ok"}
                                </span>
                              </div>
                            </div>

                            {e.body && (
                              <div className="sa-detail-summary">
                                <div className="io-head">
                                  <span>Result · summary</span>
                                  <button
                                    type="button"
                                    className="io-copy"
                                    onClick={() => copy(`sa-${e.id}`, e.body ?? "")}
                                  >
                                    {copied === `sa-${e.id}` ? "✓ copied" : "⧉ copy"}
                                  </button>
                                </div>
                                <div
                                  className="sa-summary-body"
                                  onClick={() => setSelectedEventId(e.id)}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(ev) => {
                                    if (ev.key === "Enter" || ev.key === " ") {
                                      ev.preventDefault();
                                      setSelectedEventId(e.id);
                                    }
                                  }}
                                >
                                  {invocationSummaryLine(e)}
                                </div>
                              </div>
                            )}

                            <div className="panel-title" style={{ padding: "10px 14px 0" }}>
                              Execution <span className="count">({kids.length} steps)</span>
                            </div>
                            {kids.length === 0 ? (
                              <div className="empty" style={{ padding: "8px 16px 16px" }}>
                                No internal steps were captured for this run.
                              </div>
                            ) : (
                              kids.map((k) => {
                                const isSel = selectedEventId === k.id;
                                return (
                                  <div
                                    key={k.id}
                                    className={`event-row child-row${isSel ? " selected" : ""}`}
                                    onClick={() => setSelectedEventId(k.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(ev) => {
                                      if (ev.key === "Enter" || ev.key === " ") {
                                        ev.preventDefault();
                                        setSelectedEventId(k.id);
                                      }
                                    }}
                                    style={{ cursor: "pointer" }}
                                  >
                                    <span className="event-seq">{k.seq}</span>
                                    <span className="event-gutter">{k.ts}</span>
                                    <span className={`event-icon ${k.type}`} aria-hidden>
                                      {TYPE_GLYPH[k.type] ?? "•"}
                                    </span>
                                    <div className="event-main">
                                      <div className="event-headline">
                                        <span className="event-title">{k.title}</span>
                                        <span className={`event-type-badge ${k.type}`}>
                                          {EVENT_LABEL[k.type]}
                                        </span>
                                      </div>
                                      {k.command ? (
                                        <div className="event-sub mono">{k.command}</div>
                                      ) : k.filePath ? (
                                        <div className="event-sub path">{k.filePath}</div>
                                      ) : k.body ? (
                                        <div className="event-sub body">{k.body.split("\n")[0]}</div>
                                      ) : null}
                                    </div>
                                    <span className="event-meta">
                                      {k.durationMs != null && (
                                        <span className="dur">{durLabel(k.durationMs)}</span>
                                      )}
                                      {k.exitCode != null &&
                                        (k.exitCode === 0 ? (
                                          <span className="ok">✓</span>
                                        ) : (
                                          <span className="err">✗</span>
                                        ))}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        );
                      })()
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ===== ANNOTATIONS (session-wide notable moments) ===== */}
          {activeTab === "annotations" && (
            <div className="timeline annotations-tab">
              <div className="annotations-tab-head">
                <span className="ann-tab-label">Annotations</span>
                <span className="count mono">{annotations.length}</span>
              </div>
              <div className="annotations-tab-sub">
                Notable moments flagged along the run — errors, commits &amp; tests, in time order.
                Click one to jump to that step in the Transcript.
              </div>
              {annotations.length === 0 ? (
                <div className="empty" style={{ padding: "16px" }}>
                  No flagged moments in this session.
                </div>
              ) : (
                [...annotations]
                  .sort((a, b) => a.atSeq - b.atSeq)
                  .map((a) => {
                    const target =
                      events.find((e) => e.seq === a.atSeq && !e.parentId) ??
                      events.find((e) => e.seq === a.atSeq);
                    const jump = () => {
                      if (!target) return;
                      setActiveTab("transcript");
                      selectTimelineEvent(target.id, true);
                    };
                    return (
                      <div
                        key={a.id}
                        className="annotation annotation-tab-row"
                        data-annotation-seq={a.atSeq}
                        onClick={jump}
                        role={target ? "button" : undefined}
                        tabIndex={target ? 0 : undefined}
                        onKeyDown={(ev) => {
                          if (target && (ev.key === "Enter" || ev.key === " ")) {
                            ev.preventDefault();
                            jump();
                          }
                        }}
                        title={
                          target
                            ? `${a.kind} at step ${a.atSeq} — click to jump to the Transcript`
                            : `${a.kind} at step ${a.atSeq}`
                        }
                        style={{ cursor: target ? "pointer" : "default" }}
                      >
                        <span className="amain">
                          <span className="ameta">
                            <span className={`akind-tag ${a.kind as AnnotationKind}`}>{a.kind}</span>
                            <span className="aseq">step {a.atSeq}</span>
                          </span>
                          {a.note && <span className="atxt">{a.note}</span>}
                        </span>
                      </div>
                    );
                  })
              )}
            </div>
          )}

          {/* ===== FINDINGS (Phase 2) — master-detail =====
              Left: a compact, non-actionable list (kind / title / analyst /
              confidence / evidence count / verdict state — NO accept/reject).
              Right: the選んだ finding の現物 — body + per-evidence excerpts
              (the actual command/output at that seq) + the verdict controls.
              A decision is made looking at evidence, never from the list alone. */}
          {activeTab === "findings" && (
            <div className="timeline findings-tab findings-md" data-pending-count={pendingFindingsCount}>
              <div className="findings-tab-head">
                <div className="findings-title">
                  <span className="findings-label">Findings</span>
                  <span className="count mono">{visibleFindings.length}</span>
                  <span className="finding-pending-count mono">{pendingFindingsCount} pending</span>
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
                      className={findingStatusFilter === key ? "active" : ""}
                      onClick={() => setFindingStatusFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
                <span className="segmented findings-filter" title="Session filter">
                  <button
                    type="button"
                    className={findingSessionFilter === "all" ? "active" : ""}
                    onClick={() => setFindingSessionFilter("all")}
                  >
                    All sessions
                  </button>
                  <button
                    type="button"
                    className={findingSessionFilter === currentId ? "active" : ""}
                    onClick={() => setFindingSessionFilter(currentId)}
                  >
                    This session
                  </button>
                </span>
              </div>
              {recentFindingVerdict && (
                <div
                  className={`finding-verdict-toast ${recentFindingVerdict.verdict}`}
                  data-finding-id={recentFindingVerdict.findingId}
                  data-verdict-id={recentFindingVerdict.verdictId}
                >
                  <span className="finding-status-dot" aria-hidden />
                  <span>
                    {findingVerdictLabel(recentFindingVerdict.verdict)} · {recentFindingVerdict.title}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={undoFindingVerdict}>
                    Undo
                  </button>
                </div>
              )}
              {findingError && <div className="finding-error">{findingError}</div>}
              {visibleFindings.length === 0 ? (
                <div className="empty" style={{ padding: "16px" }}>
                  No findings match the current filters.
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
                            <Link className="finding-discuss-link" href={findingDiscussHref(finding)}>
                              Discuss
                            </Link>
                          </div>
                          {finding.body && <p className="finding-detail-body">{finding.body}</p>}

                          <div className="finding-detail-section">
                            <div className="finding-section-label">
                              Evidence · {finding.evidence.length}
                            </div>
                            <div className="finding-evidence-cards">
                              {finding.evidence.map((evidence) => {
                                const target = resolveEvidence(evidence);
                                const excerpt = evidence.excerpt;
                                const narrative = excerpt?.narrative ?? null;
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
                                    key={evidence.id}
                                    className={`finding-evidence-card${target.resolved ? "" : " stale"}`}
                                    data-evidence-kind={evidence.subjectKind}
                                    data-evidence-id={evidence.id}
                                    data-resolved={target.resolved ? "true" : "false"}
                                  >
                                    {/* SESSION — which run / runner·model / when, so a finding
                                        spanning multiple sessions is never ambiguous. */}
                                    {narrative && (
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
                                          {positionLabel ? ` · ${positionLabel}` : ""}
                                        </span>
                                      </div>
                                    )}
                                    {/* USER ASKED — the request this stretch of work answers. */}
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
                                    <div className="finding-evidence-cardhead">
                                      <span className="finding-evidence-kind">{evidence.subjectKind}</span>
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
                                      <div className="finding-excerpt" data-excerpt-seq={excerpt.seq}>
                                        <div className="finding-excerpt-meta mono">
                                          <span>step {excerpt.seq}</span>
                                          <span>{excerpt.type}</span>
                                          {excerpt.exitCode != null && (
                                            <span className={excerpt.exitCode === 0 ? "ok" : "err"}>
                                              exit {excerpt.exitCode}
                                            </span>
                                          )}
                                        </div>
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
                                    {/* AFTERWARD — what the run did next (the 結末): the escape
                                        from a failure loop, or the next message in the thread. */}
                                    {narrative?.aftermath && (
                                      <div
                                        className="finding-evidence-after"
                                        data-after-seq={narrative.aftermath.seq}
                                      >
                                        <span className="finding-evidence-microlabel">Afterward</span>
                                        <div className="finding-evidence-after-meta mono">
                                          <span>step {narrative.aftermath.seq}</span>
                                          <span>{narrative.aftermath.type}</span>
                                        </div>
                                        <p className="finding-evidence-after-text">
                                          {narrative.aftermath.text}
                                        </p>
                                      </div>
                                    )}
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
                                  value={findingReasonDrafts[finding.id] ?? ""}
                                  onChange={(event) =>
                                    setFindingReasonDrafts((prev) => ({
                                      ...prev,
                                      [finding.id]: event.target.value,
                                    }))
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void submitFindingVerdict(finding, "accept");
                                    }
                                  }}
                                  placeholder="reason"
                                  aria-label={`Reason for ${finding.title}`}
                                />
                                <button
                                  type="button"
                                  className="finding-verdict-btn accept"
                                  disabled={!!findingBusy[finding.id]}
                                  onClick={() => void submitFindingVerdict(finding, "accept")}
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className="finding-verdict-btn reject"
                                  disabled={!!findingBusy[finding.id]}
                                  onClick={() => void submitFindingVerdict(finding, "reject")}
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
          )}

          {/* Git is handled above as an embedded DiffViewer (in-page tab),
              so there is no changed-files block inside <main> anymore. */}

          {/* ===== RAW JSON ===== */}
          {activeTab === "raw" && (
            <div className="timeline" style={{ padding: "12px 14px" }}>
              <div
                className="panel-title"
                style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}
              >
                <span>{selected ? `Selected event ${selected.seq}` : "Events array"}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    copy("raw-main", JSON.stringify(selected ?? events, null, 2))
                  }
                >
                  {copied === "raw-main" ? "Copied ✓" : "⧉ Copy"}
                </button>
              </div>
              <pre className="run-json" style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(selected ?? events, null, 2)}
              </pre>
            </div>
          )}

          {/* ---------- bottom strip: real time ribbon (width = elapsed time) ---------- */}
          <TimeRibbon
            events={topEvents}
            selectedId={selectedEventId}
            onSelect={(eventId) => selectTimelineEvent(eventId, true)}
            title="Time spent"
          />
        </main>

        {/* ---------- COLUMN 3: aside / detail ----------
            Hidden on the Findings tab — the event inspector (User message /
            LINKED FILES / RUN JSON) does not inform a verdict, so the column is
            removed and its width handed to the findings detail panel. */}
        {activeTab !== "findings" && (
        <aside className="aside">
          {asideIsLauncherDup ? (
            <div className="detail">
              <div className="detail-placeholder" data-aside-placeholder="step-inspect">
                Select a step to inspect
              </div>
            </div>
          ) : (
          <div className="detail">
            <div className="detail-head">
              <span className={`event-icon ${selType}`} aria-hidden>
                {TYPE_GLYPH[selType] ?? "•"}
              </span>
              <span className="dtitle">
                {selType === "bash" ? "Bash (shell)" : EVENT_LABEL[selType]}
              </span>
              <span className="spacer" />
              {selected?.exitCode != null && (
                <span className={`badge ${selStatusClass}`}>{selStatusText}</span>
              )}
            </div>

            <div className="detail-actions">
              <button
                type="button"
                className={`btn${selPinned ? " btn-primary" : ""}`}
                onClick={togglePin}
                disabled={!selected}
              >
                📌 {selPinned ? "Pinned" : "Pin"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={openNoteEditor}
                disabled={!selected}
              >
                🗒 {selNote ? "Edit Note" : "Add Note"}
              </button>
              {selected && eventsWithDiff.has(selected.id) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setGitFocusEvent(selected.id);
                    setGitFocusFileId(undefined);
                    setGitFocusHunkId(undefined);
                    setActiveTab("git");
                  }}
                  title="See the Git diff this edit produced (jump to the Git tab)"
                >
                  ⎇ Diff →
                </button>
              )}
            </div>

            {/* note editor (inline) */}
            {noteDraft != null && (
              <div style={{ padding: "0 16px 12px" }}>
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Note for this event…"
                  rows={3}
                  autoFocus
                  style={{
                    width: "100%",
                    fontFamily: "var(--sans)",
                    fontSize: "12.5px",
                    padding: "8px",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--panel)",
                    color: "var(--text)",
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={saveNote}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setNoteDraft(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* saved note display */}
            {selNote && noteDraft == null && (
              <div
                className="kv"
                style={{ borderTop: 0, paddingTop: 0, gridTemplateColumns: "1fr" }}
              >
                <dd style={{ background: "var(--accent-weak)", padding: "8px 10px", borderRadius: "var(--radius-sm)" }}>
                  🗒 {selNote}
                </dd>
              </div>
            )}

            {/* what matters for a tool: how long, success, cost — as compact stats */}
            <div className="stat-strip">
              {selected?.durationMs != null && (
                <div className="stat">
                  <span className="stat-k">Duration</span>
                  <span className="stat-v">{fmtDur2(selected.durationMs)}</span>
                </div>
              )}
              {selected?.exitCode != null && (
                <div className="stat">
                  <span className="stat-k">Exit</span>
                  <span className={`stat-v ${selected.exitCode === 0 ? "ok" : "err"}`}>
                    {selected.exitCode === 0 ? "0 ✓" : `${selected.exitCode} ✗`}
                  </span>
                </div>
              )}
              {selected?.tokenUsage != null && (
                <div className="stat">
                  <span className="stat-k">Tokens</span>
                  <span className="stat-v">{fmtInt(selected.tokenUsage)}</span>
                </div>
              )}
              {selMeta.toolUses != null && (
                <div className="stat">
                  <span className="stat-k">Tool calls</span>
                  <span className="stat-v">{selMeta.toolUses}</span>
                </div>
              )}
            </div>
            <div className="detail-sub">
              {EVENT_LABEL[selType]} · {selected?.actor ?? "—"} · {sessionDate} {selTime}
              {selMeta.tool && selMeta.tool !== EVENT_LABEL[selType] ? ` · ${selMeta.tool}` : ""}
            </div>
            {selected?.filePath && <div className="detail-path mono">{selected.filePath}</div>}

            {selected?.command && (
              <div className="io-block">
                <div className="io-head">
                  <span>Command</span>
                  <button
                    type="button"
                    className="io-copy"
                    onClick={() => copy("cmd", selected.command ?? "")}
                  >
                    {copied === "cmd" ? "✓ copied" : "⧉ copy"}
                  </button>
                </div>
                <pre className="code-block cmd">{selected.command}</pre>
              </div>
            )}

            {/* return value / side effects — the main content, gets the room */}
            <div className="io-block io-output">
              <div className="io-head">
                <span>
                  {selType === "bash" || selType === "test"
                    ? "Output · stdout / stderr"
                    : selType === "file_read"
                      ? "File contents"
                      : selType === "subagent"
                        ? "Result / summary"
                        : selType === "thinking"
                          ? "Thinking · reasoning"
                          : selType === "assistant_message" || selType === "user_message"
                            ? "Message"
                            : "Detail"}
                </span>
                {selected?.body && (
                  <button
                    type="button"
                    className="io-copy"
                    onClick={() => copy("out", selected.body ?? "")}
                  >
                    {copied === "out" ? "✓ copied" : "⧉ copy"}
                  </button>
                )}
              </div>
              <pre className="code-block output">
                {selected?.body ? selected.body : <span className="muted">(no output captured)</span>}
              </pre>
            </div>

            {/* Linked files */}
            <div className="linked-files">
              <div className="panel-title">
                Linked Files <span className="count">({selectedFiles.length})</span>
              </div>
              {selectedFiles.length === 0 ? (
                <div className="empty">—</div>
              ) : (
                selectedFiles.map((f) => (
                  <div key={f.id} className="linked-file">
                    <span>{f.path}</span>
                    <span className={`role ${f.role}`}>{f.role}</span>
                  </div>
                ))
              )}
            </div>

            {/* Run JSON */}
            <div className="linked-files" style={{ borderBottom: 0, paddingBottom: 0 }}>
              <div
                className="panel-title"
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <span>Run JSON</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => copy("runjson", JSON.stringify(runJson, null, 2))}
                  disabled={!selected}
                >
                  {copied === "runjson" ? "Copied ✓" : "⧉ Copy"}
                </button>
              </div>
            </div>
            <pre className="run-json">
              <JsonView value={runJson} />
            </pre>
          </div>
          )}
        </aside>
        )}
          </>
        )}
      </div>
    </>
  );
}
