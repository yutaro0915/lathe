"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import TimeRibbon from "@/components/TimeRibbon";
import { Surface } from "@/design-system/components";
import { findingTouchesSession } from "@/components/FindingsExplorer";
import type { Finding, Session, SessionBundle } from "@/lib/types";
import { type StepKind } from "@/lib/event-display";
import { ALL_KINDS, type FilterMode, type Tab } from "@/components/session-viewer/types";
import { useTurnRollups } from "@/components/session-viewer/useTurnRollups";
import { useTurnJumps } from "@/components/session-viewer/useTurnJumps";
import { useEventLookups } from "@/components/session-viewer/useEventLookups";
import { useEvidenceResolver } from "@/components/session-viewer/useEvidenceResolver";
import { useSessionDerivedData } from "@/components/session-viewer/useSessionDerivedData";
import { usePersistentAnnotations } from "@/components/session-viewer/usePersistentAnnotations";
import { useExpansionSets } from "@/components/session-viewer/useExpansionSets";
import { useScrollAndFlash } from "@/components/session-viewer/useScrollAndFlash";
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
import { JumpLandingBanner } from "@/components/session-viewer/JumpLandingBanner";
import { StepExpansionProvider } from "@/components/session-viewer/Step";

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
  const annotations = bundle.annotations;

  const [findings, setFindings] = useState<Finding[]>(initialFindings);
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [kindFilter, setKindFilter] = useState<Set<StepKind>>(() => new Set(ALL_KINDS));
  const [filterMode, setFilterMode] = useState<FilterMode>("hide");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [gitFocusEvent, setGitFocusEvent] = useState<string | undefined>(undefined);
  const [gitFocusFileId, setGitFocusFileId] = useState<string | undefined>(undefined);
  const [gitFocusHunkId, setGitFocusHunkId] = useState<string | undefined>(undefined);
  const [landing, setLanding] = useState<{ seq: number | null; fromFinding: number | null } | null>(
    initialFromFinding != null || initialSeq != null
      ? { seq: initialSeq ?? null, fromFinding: initialFromFinding ?? null }
      : null,
  );

  useEffect(() => setFindings(initialFindings), [initialFindings]);

  // --- derived data (all pure memos) ------------------------------------------
  const {
    seedId,
    childrenByParent,
    sessionById,
    invocations,
    eventsWithDiff,
    matchesSearch,
    topEvents,
    stepCount,
    turnNumberByEventId,
    turnHeaderIds,
    turnHeaders,
    stepsByTurn,
    kindCounts,
    editByEventId,
  } = useSessionDerivedData({ events, sessions, bundle, transcriptSearch });

  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(seedId);

  // --- expansion / collapse state --------------------------------------------
  const {
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
  } = useExpansionSets({ primaryId: primary.id, turnNumberByEventId, turnHeaderIds });

  // --- scroll + flash mechanics -----------------------------------------------
  const { flashEventId, flashStep, requestScrollToEvent } = useScrollAndFlash({
    activeTab,
    selectedEventId,
  });

  // Seed selection: on session/seedId change, select and scroll to the first event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelectedEventId(seedId);
    if (seedId) {
      setExpandedEventIds((prev) => {
        if (prev.has(seedId)) return prev;
        const next = new Set(prev);
        next.add(seedId);
        return next;
      });
      requestScrollToEvent(seedId);
    }
  }, [primary.id, seedId]);

  // --- turn rollups + jumps ---------------------------------------------------
  const turnCount = turnNumberByEventId.size;
  const turnRollups = useTurnRollups({
    bundle,
    childrenByParent,
    topEvents,
    turnHeaderIds,
    turnNumberByEventId,
  });
  const { highestTurnJump, firstErrorTurnJump } = useTurnJumps(primary.runner, turnRollups);

  // --- event lookups ----------------------------------------------------------
  const { eventById, eventBySeq } = useEventLookups(events);

  // --- selected event (drives inspector + annotation handlers) ---------------
  const selected = useMemo(
    () => events.find((e) => e.id === selectedEventId),
    [events, selectedEventId],
  );

  // --- persistent annotations (pins, notes, copy) ----------------------------
  const {
    pins,
    notes,
    noteDraft,
    setNoteDraft,
    copied,
    copy,
    togglePin,
    openNoteEditor,
    saveNote,
  } = usePersistentAnnotations(selected);

  // --- evidence resolver (findings deep-links) --------------------------------
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

  // Deep-link: jump to initialSeq on session change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (initialSeq == null) return;
    const target = eventBySeq.get(initialSeq);
    if (!target) return;
    setActiveTab("transcript");
    expandTurnForEvent(target.id);
    setSelected(target.id);
    flashStep(target.id);
    requestScrollToEvent(target.id);
  }, [primary.id, initialSeq, eventBySeq]);

  useEffect(() => {
    setLanding(
      initialFromFinding != null || initialSeq != null
        ? { seq: initialSeq ?? null, fromFinding: initialFromFinding ?? null }
        : null,
    );
  }, [primary.id, initialSeq, initialFromFinding]);

  // --- wiring helpers ---------------------------------------------------------
  function setSelected(eventId: string, expansion: "open" | "toggle" = "open") {
    setSelectedEventId(eventId);
    expandEvent(eventId, expansion);
  }
  function selectStep(eventId: string) { setSelected(eventId, "toggle"); }
  function selectTimelineEvent(eventId: string, expandTurn = false) {
    if (expandTurn) expandTurnForEvent(eventId);
    setSelected(eventId);
    flashStep(eventId);
    requestScrollToEvent(eventId);
  }
  function jumpToTurn(headerId: string) {
    setActiveTab("transcript");
    expandTurnForEvent(headerId);
    setSelected(headerId);
    requestScrollToEvent(headerId);
  }
  function jumpToFindingSession(sessionId: string, findingId?: number) {
    if (sessionId === currentId) {
      setActiveTab("transcript");
      if (findingId != null) setLanding({ seq: null, fromFinding: findingId });
      return;
    }
    router.push(
      `/?session=${encodeURIComponent(sessionId)}&tab=transcript${findingId != null ? `&fromFinding=${findingId}` : ""}`,
    );
  }
  function jumpToFindingTurn(sessionId: string, _turn: number, headSeq: number | null, findingId?: number) {
    if (sessionId === currentId) {
      setActiveTab("transcript");
      const target = headSeq != null ? eventBySeq.get(headSeq) : undefined;
      if (target) selectTimelineEvent(target.id, true);
      if (findingId != null || headSeq != null)
        setLanding({ seq: headSeq, fromFinding: findingId ?? null });
      return;
    }
    router.push(
      `/?session=${encodeURIComponent(sessionId)}&tab=transcript${headSeq != null ? `&seq=${headSeq}` : ""}${findingId != null ? `&fromFinding=${findingId}` : ""}`,
    );
  }
  // slice 9: single-select toggle for a subagent card/row.
  function selectLauncher(launcherId: string) {
    setSelectedLauncherId((prev) => (prev === launcherId ? null : launcherId));
    setSelected(launcherId);
  }
  function openSubSession(id: string) {
    router.push(`/?session=${encodeURIComponent(id)}&tab=transcript`);
  }
  function toggleKind(k: StepKind) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  const clearGitFocus = () => {
    setGitFocusEvent(undefined);
    setGitFocusFileId(undefined);
    setGitFocusHunkId(undefined);
  };
  const openSelectedDiff = () => {
    if (selected) setGitFocusEvent(selected.id);
    setGitFocusFileId(undefined);
    setGitFocusHunkId(undefined);
    setActiveTab("git");
  };

  // --- derived view values ----------------------------------------------------
  const selectedFiles = selected ? bundle.eventFiles[selected.id] ?? [] : [];
  const branch = primary.gitBranch ?? "main";
  const commitLabel = `${primary.commitCount} commit${primary.commitCount === 1 ? "" : "s"}`;
  const currentSessionFindings = useMemo(
    () => findings.filter((finding) => findingTouchesSession(finding, currentId)),
    [currentId, findings],
  );
  const currentSessionPendingFindings = useMemo(
    () => currentSessionFindings.filter((finding) => !finding.verdict),
    [currentSessionFindings],
  );

  // --- layout -----------------------------------------------------------------
  // git / stats / findings / tools / skills / subagents fill the whole work area
  // (no inspector pane). transcript is now an INLINE turn-accordion that fills the
  // whole work area too (D6 / ADR-detail-wider-than-list).
  const isFullWidthTab =
    activeTab === "git" ||
    activeTab === "stats" ||
    activeTab === "findings" ||
    activeTab === "tools" ||
    activeTab === "skills" ||
    activeTab === "subagents";
  const isTranscriptTab = activeTab === "transcript";

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
    <SessionTabs
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      annotationsCount={annotations.length}
      pendingFindingsCount={currentSessionPendingFindings.length}
      visibleCount={stepCount}
      clearGitFocus={clearGitFocus}
    />
  );

  const detailProps = {
    selected, selectedFiles, primary, pins, notes, noteDraft, setNoteDraft,
    copied, copy, eventsWithDiff, togglePin, openNoteEditor, saveNote, openSelectedDiff,
  };
  const ribbon = (
    <TimeRibbon
      events={topEvents}
      selectedId={selectedEventId}
      onSelect={(eventId) => selectTimelineEvent(eventId, true)}
      title="Time spent"
    />
  );
  const banner = <JumpLandingBanner landing={landing} onDismiss={() => setLanding(null)} />;

  const body = isFullWidthTab ? (
    <div className="lds-sv-fill" data-testid="main" data-tab={activeTab}>
      {activeTab === "git" && (
        <GitTab
          bundle={bundle}
          currentId={currentId}
          focusEventId={gitFocusEvent}
          focusFileId={gitFocusFileId}
          focusHunkId={gitFocusHunkId}
          onJumpToEvent={(eid) => { setActiveTab("transcript"); selectTimelineEvent(eid, true); clearGitFocus(); }}
        />
      )}
      {activeTab === "stats" && <StatsTab bundle={bundle} />}
      {/* D11/D12/D8 (slice 7): Tools is a type-aggregated comparison-list that
          expands its invocations inline (no side inspector). */}
      {activeTab === "tools" && (
        <ToolsTab
          bundle={bundle}
          expandedTypes={expandedToolTypes}
          toggleType={toggleToolType}
          selectedEventId={selectedEventId} selectEvent={selectStep}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
          editByEventId={editByEventId}
          childrenByParent={childrenByParent}
          flashEventId={flashEventId}
        />
      )}
      {/* D33/D11/D12/D8 (slice 8): Skills is a capability-aggregated
          comparison-list that expands its invocations inline (no side
          inspector) — the SAME shared ComparisonList shape as Tools. */}
      {activeTab === "skills" && (
        <SkillsTab
          bundle={bundle}
          expandedSkills={expandedSkills}
          toggleSkill={toggleSkill}
          selectedEventId={selectedEventId} selectEvent={selectStep}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
          editByEventId={editByEventId}
          childrenByParent={childrenByParent}
          flashEventId={flashEventId}
        />
      )}
      {activeTab === "findings" && (
        <FindingsTab
          findings={findings}
          setFindings={setFindings}
          sessions={sessions}
          currentId={currentId}
          resolveEvidence={resolveEvidence}
          onJumpToSession={jumpToFindingSession}
          onJumpToTurn={jumpToFindingTurn}
        />
      )}
      {/* D16–D18 (slice 9): Subagents is a [By step | All] view whose selection
          expands an inline nested mini-session — full-width, no side inspector. */}
      {activeTab === "subagents" && (
        <SubagentsTab
          invocations={invocations}
          topEvents={topEvents}
          turnNumberByEventId={turnNumberByEventId}
          turnHeaderIds={turnHeaderIds}
          childrenByParent={childrenByParent}
          sessionById={sessionById}
          bundle={bundle}
          currentId={currentId}
          selectedLauncherId={selectedLauncherId}
          selectLauncher={selectLauncher}
          selectedEventId={selectedEventId} selectEvent={selectStep}
          flashEventId={flashEventId}
          editByEventId={editByEventId}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
          openSubSession={openSubSession}
        />
      )}
    </div>
  ) : isTranscriptTab ? (
    <div className="lds-sv-main" data-testid="main" data-tab={activeTab}>
      {banner}
      {/* D6 inline turn-accordion: full-width, no side detail pane, no gutter
          (D5), no TimeRibbon. Turns collapsed by default; expanding a turn shows
          its steps inline; a step expands its detail-block in place. */}
      <TranscriptTab
        transcriptSearch={transcriptSearch}
        setTranscriptSearch={setTranscriptSearch}
        turnCount={turnCount}
        collapsedTurns={collapsedTurns}
        expandAllTurns={() => setCollapsedTurns(new Set())}
        collapseAllTurns={() => setCollapsedTurns(new Set(turnNumberByEventId.keys()))}
        toggleTurn={toggleTurn}
        turnHeaders={turnHeaders}
        turnNumberByEventId={turnNumberByEventId}
        turnRollups={turnRollups}
        stepsByTurn={stepsByTurn}
        childrenByParent={childrenByParent}
        kindFilter={kindFilter}
        toggleKind={toggleKind}
        kindCounts={kindCounts}
        filterMode={filterMode}
        setFilterMode={setFilterMode}
        selectedEventId={selectedEventId} flashEventId={flashEventId}
        expandedAgents={expandedAgents}
        toggleAgent={toggleAgent}
        selectStep={selectStep}
        editByEventId={editByEventId}
        matchesSearch={matchesSearch}
      />
    </div>
  ) : (
    <div className="lds-sv-main" data-testid="main" data-tab={activeTab}>
      {banner}
      {activeTab === "annotations" && (
        <AnnotationsTab
          annotations={annotations}
          events={events}
          jumpToEvent={(id) => { setActiveTab("transcript"); selectTimelineEvent(id, true); }}
        />
      )}
      {activeTab === "raw" && (
        <RawTab selected={selected} events={events} copied={copied} copy={copy} />
      )}
      {ribbon}
    </div>
  );

  const inspector = <SessionAside {...detailProps} />;

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
      <StepExpansionProvider expandedEventIds={expandedEventIds}>{body}</StepExpansionProvider>
    </Surface>
  );
}
