"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Surface from "@/components/Surface";
import TimeRibbon from "@/components/TimeRibbon";
import { findingTouchesSession } from "@/components/FindingsExplorer";
import type { EventType, Finding, Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import { clampPct, hmsToMs, ALL_TYPES, type FilterMode, type Tab } from "@/components/session-viewer/types";
import { useTurnRollups } from "@/components/session-viewer/useTurnRollups";
import { useEvidenceResolver } from "@/components/session-viewer/useEvidenceResolver";
import { MetricsBarTitle, MetricsBarMeta, MetricsBarActions } from "@/components/session-viewer/MetricsBar";
import { SessionTabs } from "@/components/session-viewer/SessionTabs";
import { GitTab } from "@/components/session-viewer/GitTab";
import { StatsTab } from "@/components/session-viewer/StatsTab";
import { TranscriptTab } from "@/components/session-viewer/TranscriptTab";
import { ToolsTab } from "@/components/session-viewer/ToolsTab";
import { SkillsTab } from "@/components/session-viewer/SkillsTab";
import { SubagentsTab } from "@/components/session-viewer/SubagentsTab";
import { AnnotationsTab } from "@/components/session-viewer/AnnotationsTab";
import { FindingsTab } from "@/components/session-viewer/FindingsTab";
import { RawTab } from "@/components/session-viewer/RawTab";
import { SessionAside } from "@/components/session-viewer/SessionAside";
import { SessionDetailWide } from "@/components/session-viewer/SessionDetailWide";
import { JumpLandingBanner } from "@/components/session-viewer/JumpLandingBanner";

const DAY_MS = 24 * 60 * 60 * 1000;
const LS_PINS = "lathe.pins";
const LS_NOTES = "lathe.notes";

export default function SessionViewer({
  sessions,
  bundle,
  currentId,
  findings: initialFindings,
  initialTab = "transcript",
  initialSeq,
  initialFromFinding,
}: {
  sessions: Session[];
  bundle: SessionBundle;
  currentId: string;
  findings: Finding[];
  initialTab?: Tab;
  initialSeq?: number;
  initialFromFinding?: number;
}) {
  const router = useRouter();
  const primary = bundle.session;
  const primaryPrs = bundle.pullRequests;
  const events = bundle.events;
  const typeCounts = bundle.typeCounts;
  const annotations = bundle.annotations;

  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [typeFilter, setTypeFilter] = useState<Set<EventType>>(() => new Set(ALL_TYPES));
  const [filterMode, setFilterMode] = useState<FilterMode>("hide");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());
  const [subAgentTab, setSubAgentTab] = useState<string>("overview");
  const [gitFocusEvent, setGitFocusEvent] = useState<string | undefined>(undefined);
  const [gitFocusFileId, setGitFocusFileId] = useState<string | undefined>(undefined);
  const [gitFocusHunkId, setGitFocusHunkId] = useState<string | undefined>(undefined);
  const [flashEventId, setFlashEventId] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ seq: number | null; fromFinding: number | null } | null>(
    initialFromFinding != null || initialSeq != null ? { seq: initialSeq ?? null, fromFinding: initialFromFinding ?? null } : null,
  );
  const [pins, setPins] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setFindings(initialFindings), [initialFindings]);
  useEffect(() => setSubAgentTab("overview"), [primary.id]);

  const seedId = useMemo(() => {
    const first = events.find((e) => !e.parentId) ?? events[0];
    return first?.id;
  }, [events]);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(seedId);
  useEffect(() => setSelectedEventId(seedId), [seedId]);

  useEffect(() => {
    if (!selectedEventId || typeof document === "undefined") return;
    const sel = typeof CSS !== "undefined" && CSS.escape ? `[data-eid="${CSS.escape(selectedEventId)}"]` : null;
    const el = sel ? document.querySelector(sel) : null;
    if (el) el.scrollIntoView({ block: "center" });
  }, [selectedEventId, activeTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rawPins = window.localStorage.getItem(LS_PINS);
      if (rawPins) setPins(new Set(JSON.parse(rawPins) as string[]));
    } catch {}
    try {
      const rawNotes = window.localStorage.getItem(LS_NOTES);
      if (rawNotes) setNotes(JSON.parse(rawNotes) as Record<string, string>);
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

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

  const sessionById = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);
  const invocations = useMemo(() => events.filter((e) => e.type === "subagent" && !e.parentId), [events]);
  const eventsWithDiff = useMemo(() => {
    const s = new Set<string>();
    for (const hunkList of Object.values(bundle.hunks)) {
      for (const h of hunkList) {
        for (const a of bundle.attributions[h.id] ?? []) if (a.eventId) s.add(a.eventId);
      }
    }
    return s;
  }, [bundle.hunks, bundle.attributions]);

  const matchesSearch = useMemo(() => {
    const q = transcriptSearch.trim().toLowerCase();
    return (e: TranscriptEvent) => {
      if (!q) return true;
      const hay = `${e.title} ${e.command ?? ""} ${e.filePath ?? ""} ${e.body ?? ""}`.toLowerCase();
      return hay.includes(q);
    };
  }, [transcriptSearch]);
  const matchesType = useMemo(() => (e: TranscriptEvent) => typeFilter.has(e.type), [typeFilter]);
  const shouldRenderTimelineEvent = useMemo(
    () => (e: TranscriptEvent) => matchesSearch(e) && (filterMode === "highlight" || matchesType(e)),
    [filterMode, matchesSearch, matchesType],
  );
  const topEvents = useMemo(() => events.filter((e) => !e.parentId), [events]);
  const visibleEvents = useMemo(() => topEvents.filter(shouldRenderTimelineEvent), [topEvents, shouldRenderTimelineEvent]);

  const { turnNumberByEventId, turnHeaderIds } = useMemo(() => {
    const turnNumberByEventId = new Map<string, number>();
    const turnHeaderIds = new Map<string, string>();
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
  const turnRollups = useTurnRollups({ bundle, childrenByParent, topEvents, turnHeaderIds, turnNumberByEventId });

  useEffect(() => setCollapsedTurns(new Set(turnNumberByEventId.keys())), [primary.id, turnNumberByEventId]);

  const highestTurnJump = useMemo(() => {
    let best: { headerId: string; turn: number; score: number; basis: "cost" | "duration" } | null = null;
    const useCostBasis = primary.runner === "claude-code" && [...turnRollups.values()].some((r) => r.costUsd != null && Number.isFinite(r.costUsd));
    for (const [headerId, r] of turnRollups.entries()) {
      const basis: "cost" | "duration" = useCostBasis ? "cost" : "duration";
      const score = basis === "cost" ? (r.costUsd ?? -1) : r.wallDurationMs > 0 ? r.wallDurationMs : r.durationMs;
      if (score < 0) continue;
      if (!best || score > best.score || (score === best.score && r.turn < best.turn)) best = { headerId, turn: r.turn, score, basis };
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

  const selected = useMemo(() => events.find((e) => e.id === selectedEventId), [events, selectedEventId]);
  const selectedFiles = selected ? bundle.eventFiles[selected.id] ?? [] : [];
  const branch = primary.gitBranch ?? "main";
  const commitLabel = `${primary.commitCount} commit${primary.commitCount === 1 ? "" : "s"}`;
  const currentSessionFindings = useMemo(() => findings.filter((finding) => findingTouchesSession(finding, currentId)), [currentId, findings]);
  const currentSessionPendingFindings = useMemo(() => currentSessionFindings.filter((finding) => !finding.verdict), [currentSessionFindings]);
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const eventBySeq = useMemo(() => {
    const map = new Map<number, TranscriptEvent>();
    for (const event of events) {
      if (!event.parentId && !map.has(event.seq)) map.set(event.seq, event);
      if (!map.has(event.seq)) map.set(event.seq, event);
    }
    return map;
  }, [events]);

  useEffect(() => {
    if (initialSeq == null) return;
    const target = eventBySeq.get(initialSeq);
    if (!target) return;
    setActiveTab("transcript");
    expandTurnForEvent(target.id);
    setSelectedEventId(target.id);
    flashStep(target.id);
    if (typeof document !== "undefined") {
      requestAnimationFrame(() => {
        const sel = typeof CSS !== "undefined" && CSS.escape ? `[data-eid="${CSS.escape(target.id)}"]` : null;
        const el = sel ? document.querySelector(sel) : null;
        if (el) el.scrollIntoView({ block: "center" });
      });
    }
  }, [primary.id, initialSeq, eventBySeq]);

  useEffect(() => {
    setLanding(initialFromFinding != null || initialSeq != null ? { seq: initialSeq ?? null, fromFinding: initialFromFinding ?? null } : null);
  }, [primary.id, initialSeq, initialFromFinding]);

  function persistPins(next: Set<string>) {
    setPins(next);
    if (typeof window !== "undefined") window.localStorage.setItem(LS_PINS, JSON.stringify(Array.from(next)));
  }
  function persistNotes(next: Record<string, string>) {
    setNotes(next);
    if (typeof window !== "undefined") window.localStorage.setItem(LS_NOTES, JSON.stringify(next));
  }
  function copy(key: string, text: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1200);
  }
  function toggleTurn(headerId: string) {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(headerId)) next.delete(headerId);
      else next.add(headerId);
      return next;
    });
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
  function jumpToFindingSession(sessionId: string, findingId?: number) {
    if (sessionId === currentId) {
      setActiveTab("transcript");
      if (findingId != null) setLanding({ seq: null, fromFinding: findingId });
      return;
    }
    router.push(`/?session=${encodeURIComponent(sessionId)}&tab=transcript${findingId != null ? `&fromFinding=${findingId}` : ""}`);
  }
  function jumpToFindingTurn(sessionId: string, _turn: number, headSeq: number | null, findingId?: number) {
    if (sessionId === currentId) {
      setActiveTab("transcript");
      const target = headSeq != null ? eventBySeq.get(headSeq) : undefined;
      if (target) selectTimelineEvent(target.id, true);
      if (findingId != null || headSeq != null) setLanding({ seq: headSeq, fromFinding: findingId ?? null });
      return;
    }
    router.push(`/?session=${encodeURIComponent(sessionId)}&tab=transcript${headSeq != null ? `&seq=${headSeq}` : ""}${findingId != null ? `&fromFinding=${findingId}` : ""}`);
  }
  function openAgent(launcherId: string) {
    setSubAgentTab(launcherId);
    setSelectedEventId(launcherId);
  }
  function openSubSession(id: string) {
    router.push(`/?session=${encodeURIComponent(id)}&tab=transcript`);
  }
  function toggleType(t: EventType) {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }
  function togglePin() {
    if (!selected) return;
    const next = new Set(pins);
    if (next.has(selected.id)) next.delete(selected.id);
    else next.add(selected.id);
    persistPins(next);
  }
  function openNoteEditor() {
    if (selected) setNoteDraft(notes[selected.id] ?? "");
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

  const resolveEvidence = useEvidenceResolver({
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
  });

  const asideIsLauncherDup = activeTab === "subagents" && subAgentTab !== "overview" && selectedEventId === subAgentTab;
  const setSelected = (eventId: string) => setSelectedEventId(eventId);
  const clearGitFocus = () => {
    setGitFocusEvent(undefined);
    setGitFocusFileId(undefined);
    setGitFocusHunkId(undefined);
  };

  // git / stats / findings fill the whole work area (no inspector pane).
  // transcript is a wide master-detail in the body (the detail lives wide, NOT in
  // a narrow Surface RightPanel — annotation #6 / design/layout-architecture.md
  // row #6). Every OTHER tab (tools/skills/subagents/annotations/raw) still gets
  // the narrow inspector via the Surface RightPanel (its sa-detail/step-inspect
  // contract depends on the aside living there).
  const isFullWidthTab = activeTab === "git" || activeTab === "stats" || activeTab === "findings";
  const isTranscriptTab = activeTab === "transcript";

  // The metrics feed the one shell-owned WorkareaHeader through the Surface
  // contract: the title cluster (runner dot + session title) is the Surface
  // `title`, the model/branch/commits/date is the `meta`, and the jump/PR chips
  // + kstats are the `actions` (right). The Surface header carries the `sessbar`
  // testid via `headerTestId`, so no self-drawn band — the standard header lays
  // it out (title flex-left, actions right, full width).
  const headerTitle = <MetricsBarTitle primary={primary} />;
  const headerMeta = <MetricsBarMeta primary={primary} branch={branch} commitLabel={commitLabel} />;
  const headerActions = (
    <MetricsBarActions
      primary={primary}
      primaryPrs={primaryPrs}
      currentSessionFindingsCount={currentSessionFindings.length}
      currentSessionPendingFindingsCount={currentSessionPendingFindings.length}
      highestTurnJump={highestTurnJump}
      firstErrorTurnJump={firstErrorTurnJump}
      openCurrentSessionFindings={() => setActiveTab("findings")}
      jumpToTurn={jumpToTurn}
    />
  );
  const tabs = (
    <SessionTabs activeTab={activeTab} setActiveTab={setActiveTab} annotationsCount={annotations.length} pendingFindingsCount={currentSessionPendingFindings.length} visibleCount={visibleEvents.length} clearGitFocus={clearGitFocus} />
  );

  const openSelectedDiff = () => { if (selected) setGitFocusEvent(selected.id); setGitFocusFileId(undefined); setGitFocusHunkId(undefined); setActiveTab("git"); };

  // Shared detail props: the NARROW inspector (SessionAside, in the Surface
  // RightPanel for tools/skills/subagents/annotations/raw) and the WIDE
  // transcript detail (SessionDetailWide, in the body) read the same selected
  // step + pin/note/copy plumbing. Both own the `aside` testid + detail markup.
  const detailProps = {
    selected, selectedFiles, primary, pins, notes, noteDraft, setNoteDraft,
    copied, copy, eventsWithDiff, togglePin, openNoteEditor, saveNote, openSelectedDiff,
  };
  const ribbon = <TimeRibbon events={topEvents} selectedId={selectedEventId} onSelect={(eventId) => selectTimelineEvent(eventId, true)} title="Time spent" />;
  const banner = <JumpLandingBanner landing={landing} onDismiss={() => setLanding(null)} />;

  const body = isFullWidthTab ? (
    <div className="lds-sv-fill" data-testid="main" data-tab={activeTab}>
      {activeTab === "git" && <GitTab bundle={bundle} currentId={currentId} focusEventId={gitFocusEvent} focusFileId={gitFocusFileId} focusHunkId={gitFocusHunkId} onJumpToEvent={(eid) => { setActiveTab("transcript"); selectTimelineEvent(eid, true); clearGitFocus(); }} />}
      {activeTab === "stats" && <StatsTab bundle={bundle} />}
      {activeTab === "findings" && <FindingsTab findings={findings} setFindings={setFindings} sessions={sessions} currentId={currentId} resolveEvidence={resolveEvidence} onJumpToSession={jumpToFindingSession} onJumpToTurn={jumpToFindingTurn} />}
    </div>
  ) : isTranscriptTab ? (
    <div className="lds-sv-main" data-testid="main" data-tab={activeTab}>
      {banner}
      {/* Transcript master-detail: a scannable event list on the LEFT (~35%) and a
          WIDE detail on the RIGHT (~65%, dominant). Mirrors Findings/PR. The
          TimeRibbon stays pinned full-width at the bottom. */}
      <div className="lds-sv-tx-md" data-testid="lds-sv-tx-md">
        <div className="lds-sv-tx-list" data-testid="lds-sv-tx-list">
          <TranscriptTab
            transcriptSearch={transcriptSearch}
            setTranscriptSearch={setTranscriptSearch}
            turnCount={turnCount}
            collapsedTurns={collapsedTurns}
            expandAllTurns={() => setCollapsedTurns(new Set())}
            collapseAllTurns={() => setCollapsedTurns(new Set(turnNumberByEventId.keys()))}
            typeFilter={typeFilter}
            toggleType={toggleType}
            typeCounts={typeCounts}
            filterMode={filterMode}
            setFilterMode={setFilterMode}
            visibleEvents={visibleEvents}
            childrenByParent={childrenByParent}
            shouldRenderTimelineEvent={shouldRenderTimelineEvent}
            turnHeaderIds={turnHeaderIds}
            turnNumberByEventId={turnNumberByEventId}
            turnRollups={turnRollups}
            selectedEventId={selectedEventId}
            flashEventId={flashEventId}
            pins={pins}
            notes={notes}
            expandedAgents={expandedAgents}
            matchesType={matchesType}
            eventTimeBars={eventTimeBars}
            commitLabel={commitLabel}
            selectTimelineEvent={selectTimelineEvent}
            setSelectedEventId={setSelected}
            toggleTurn={toggleTurn}
            toggleAgent={(eventId) => setExpandedAgents((prev) => { const n = new Set(prev); if (n.has(eventId)) n.delete(eventId); else n.add(eventId); return n; })}
            openAgent={(id) => { setActiveTab("subagents"); openAgent(id); }}
            openTurnFile={(fileId) => { setGitFocusFileId(fileId); setGitFocusEvent(undefined); setGitFocusHunkId(undefined); setActiveTab("git"); }}
          />
        </div>
        <div className="lds-sv-tx-detail" data-testid="lds-sv-tx-detail">
          <SessionDetailWide {...detailProps} />
        </div>
      </div>
      {ribbon}
    </div>
  ) : (
    <div className="lds-sv-main" data-testid="main" data-tab={activeTab}>
      {banner}
      {activeTab === "tools" && <ToolsTab events={events} selectedEventId={selectedEventId} setSelectedEventId={setSelected} />}
      {activeTab === "skills" && <SkillsTab events={events} selectedEventId={selectedEventId} setSelectedEventId={setSelected} />}
      {activeTab === "subagents" && <SubagentsTab invocations={invocations} subAgentTab={subAgentTab} setSubAgentTab={setSubAgentTab} childrenByParent={childrenByParent} sessionById={sessionById} selectedEventId={selectedEventId} setSelectedEventId={setSelected} copied={copied} copy={copy} openAgent={openAgent} openSubSession={openSubSession} />}
      {activeTab === "annotations" && <AnnotationsTab annotations={annotations} events={events} jumpToEvent={(id) => { setActiveTab("transcript"); selectTimelineEvent(id, true); }} />}
      {activeTab === "raw" && <RawTab selected={selected} events={events} copied={copied} copy={copy} />}
      {ribbon}
    </div>
  );

  // The narrow inspector (Surface RightPanel) — only for the list+inspector tabs.
  const inspector = <SessionAside asideIsLauncherDup={asideIsLauncherDup} {...detailProps} />;

  return (
    <Surface
      surface="session"
      headerTestId="sessbar"
      title={headerTitle}
      meta={headerMeta}
      actions={headerActions}
      tabs={tabs}
      rightPanel={isFullWidthTab || isTranscriptTab ? undefined : { title: "Inspector", children: inspector }}
    >
      {body}
    </Surface>
  );
}
