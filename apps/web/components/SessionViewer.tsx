"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TimeRibbon from "@/components/TimeRibbon";
import { findingTouchesSession } from "@/components/FindingsExplorer";
import type { EventType, Finding, Session, SessionBundle, TranscriptEvent } from "@/lib/types";
import { clampPct, hmsToMs, ALL_TYPES, type FilterMode, type Tab } from "@/components/session-viewer/types";
import { useTurnRollups } from "@/components/session-viewer/useTurnRollups";
import { useEvidenceResolver } from "@/components/session-viewer/useEvidenceResolver";
import { MetricsBar } from "@/components/session-viewer/MetricsBar";
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

  return (
    <>
      <MetricsBar
        primary={primary}
        primaryPrs={primaryPrs}
        branch={branch}
        commitLabel={commitLabel}
        currentSessionFindingsCount={currentSessionFindings.length}
        currentSessionPendingFindingsCount={currentSessionPendingFindings.length}
        highestTurnJump={highestTurnJump}
        firstErrorTurnJump={firstErrorTurnJump}
        openCurrentSessionFindings={() => setActiveTab("findings")}
        jumpToTurn={jumpToTurn}
      />
      <SessionTabs activeTab={activeTab} setActiveTab={setActiveTab} annotationsCount={annotations.length} pendingFindingsCount={currentSessionPendingFindings.length} visibleCount={visibleEvents.length} clearGitFocus={clearGitFocus} />
      <div className="lds-layout3" data-testid="layout3" data-tab={activeTab} style={{ gridTemplateColumns: activeTab === "findings" ? "0 minmax(0,1fr) 0" : "0 minmax(0,1fr) var(--aside-w)" }}>
        {activeTab === "git" ? (
          <GitTab sessions={sessions} bundle={bundle} currentId={currentId} focusEventId={gitFocusEvent} focusFileId={gitFocusFileId} focusHunkId={gitFocusHunkId} onJumpToEvent={(eid) => { setActiveTab("transcript"); selectTimelineEvent(eid, true); clearGitFocus(); }} />
        ) : activeTab === "stats" ? (
          <StatsTab bundle={bundle} />
        ) : (
          <>
            <main className="lds-layout-main" data-testid="main">
              {landing && (landing.fromFinding != null || landing.seq != null) && (
                <div className="jump-landing-banner" data-testid="jump-landing-banner" data-from-finding={landing.fromFinding ?? undefined}>
                  <span className="jump-landing-dot" data-testid="jump-landing-dot" aria-hidden>▸</span>
                  <span className="jump-landing-text mono" data-testid="jump-landing-text">
                    {landing.seq != null ? `JUMPED TO STEP ${landing.seq}` : "JUMPED TO THIS SESSION"}
                    {landing.fromFinding != null ? ` — from finding #${landing.fromFinding}` : ""}
                  </span>
                  <button type="button" className="jump-landing-dismiss" data-testid="jump-landing-dismiss" title="Dismiss" aria-label="Dismiss landing banner" onClick={() => setLanding(null)}>✕</button>
                </div>
              )}
              {activeTab === "transcript" && (
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
              )}
              {activeTab === "tools" && <ToolsTab events={events} selectedEventId={selectedEventId} setSelectedEventId={setSelected} />}
              {activeTab === "skills" && <SkillsTab events={events} selectedEventId={selectedEventId} setSelectedEventId={setSelected} />}
              {activeTab === "subagents" && <SubagentsTab invocations={invocations} subAgentTab={subAgentTab} setSubAgentTab={setSubAgentTab} childrenByParent={childrenByParent} sessionById={sessionById} selectedEventId={selectedEventId} setSelectedEventId={setSelected} copied={copied} copy={copy} openAgent={openAgent} openSubSession={openSubSession} />}
              {activeTab === "annotations" && <AnnotationsTab annotations={annotations} events={events} jumpToEvent={(id) => { setActiveTab("transcript"); selectTimelineEvent(id, true); }} />}
              {activeTab === "findings" && <FindingsTab findings={findings} setFindings={setFindings} sessions={sessions} currentId={currentId} resolveEvidence={resolveEvidence} onJumpToSession={jumpToFindingSession} onJumpToTurn={jumpToFindingTurn} />}
              {activeTab === "raw" && <RawTab selected={selected} events={events} copied={copied} copy={copy} />}
              <TimeRibbon events={topEvents} selectedId={selectedEventId} onSelect={(eventId) => selectTimelineEvent(eventId, true)} title="Time spent" />
            </main>
            {activeTab !== "findings" && (
              <SessionAside
                asideIsLauncherDup={asideIsLauncherDup}
                selected={selected}
                selectedFiles={selectedFiles}
                primary={primary}
                pins={pins}
                notes={notes}
                noteDraft={noteDraft}
                setNoteDraft={setNoteDraft}
                copied={copied}
                copy={copy}
                eventsWithDiff={eventsWithDiff}
                togglePin={togglePin}
                openNoteEditor={openNoteEditor}
                saveNote={saveNote}
                openSelectedDiff={() => { if (selected) setGitFocusEvent(selected.id); setGitFocusFileId(undefined); setGitFocusHunkId(undefined); setActiveTab("git"); }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
