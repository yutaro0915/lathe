import {
  BISECTION_ACCIDENT,
  DATA_DEPENDENT_FLAKE,
  PORT_COLLISION,
  RISKY_COMMAND,
  SELF_SUFFICIENT_FIXTURE,
  eventText,
  makeFinding,
  sessionEvidence,
  shorten,
  turnEvidence,
  type AnalystCandidate,
  type AnalystFindingDraft,
  type EventRow,
  type RunAnalystOptions,
  type SessionRow,
} from './common';
import { listEventsForSessions, listTargetSessions, listUnattributedDiffSignals } from './queries';

function normalizeCommand(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/(["'])(?:[^"']{20,})\1/g, '$1…$1')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 220);
}

export function detectFailureLoops(
  analyst: AnalystCandidate,
  sessions: Map<string, SessionRow>,
  events: EventRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  for (const [sessionId, sessionEvents] of eventsBySession(events)) {
    const session = sessions.get(sessionId);
    if (!session) continue;
    const failed = sessionEvents.filter((event) => event.exit_code != null && event.exit_code !== 0);
    if (options.turn) {
      out.push(...detectScopedFailure(analyst, session, failed, options));
      continue;
    }
    out.push(...detectRepeatedFailedCommands(analyst, session, failed));
    out.push(...detectFailureCues(analyst, session, sessionEvents));
  }
  return out;
}

export async function detectUnattributedDiff(
  analyst: AnalystCandidate,
  options: RunAnalystOptions,
): Promise<AnalystFindingDraft[]> {
  const rows = await listUnattributedDiffSignals(options);
  return rows.map((row) =>
    makeFinding({
      analyst,
      detector: 'unattributed_hunk_ratio',
      kind: 'unattributed_diff',
      title: `Unattributed diff concentration in ${row.session_id.slice(0, 8)}`,
      body: `The session has ${row.unattributed}/${row.hunks} diff hunks without a direct event attribution. The phenomenon is a diff-to-transcript gap that weakens traceability for the changed files.`,
      confidence: Math.min(0.92, 0.65 + row.unattributed / Math.max(1, row.hunks)),
      projectId: row.project_id,
      harnessVersionId: row.harness_version_id,
      evidence: [
        row.first_hunk_id
          ? {
              subjectKind: 'hunk',
              subjectId: row.first_hunk_id,
              sessionId: row.session_id,
              locator: { path: row.first_path ?? undefined },
              note: 'first unattributed hunk',
            }
          : sessionEvidence(row.session_id, 'session with unattributed diff concentration'),
      ],
    }),
  );
}

export function detectExcessCost(
  analyst: AnalystCandidate,
  sessions: SessionRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  if (options.turn) return [];
  return sessions
    .filter((session) => session.cost_anomaly && session.cost_usd != null)
    .map((session) =>
      makeFinding({
        analyst,
        detector: 'cost_anomaly_baseline',
        kind: 'excess_cost',
        title: `Cost exceeds ${session.runner} baseline in ${session.title}`,
        body: `The session cost was $${session.cost_usd!.toFixed(2)}, above the current ${session.runner} threshold of $${session.cost_threshold_usd.toFixed(2)} derived from group size ${session.cost_group_size}. The phenomenon is an unusually expensive run compared with nearby observed sessions.`,
        confidence: Math.min(0.96, 0.78 + session.cost_usd! / Math.max(session.cost_threshold_usd * 10, 1)),
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        evidence: [sessionEvidence(session.id, 'cost anomaly session')],
      }),
    );
}

export function detectRiskyActions(
  analyst: AnalystCandidate,
  sessions: Map<string, SessionRow>,
  events: EventRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  for (const event of events) {
    if (options.turn && event.seq !== options.turn.seq) continue;
    const session = sessions.get(event.session_id);
    if (!session) continue;
    const text = eventText(event);
    const risky = RISKY_COMMAND.test(text);
    const bisection = BISECTION_ACCIDENT.test(text);
    if (!risky && !bisection) continue;
    out.push(
      makeFinding({
        analyst,
        detector: risky ? 'risky_command_pattern' : 'bisection_accident_cue',
        kind: 'risky_action',
        title: risky ? `High-impact shell action in ${session.title}` : `Premature binary framing cue in ${session.title}`,
        body: risky
          ? `The transcript includes a shell action with broad destructive or process-killing potential. The phenomenon is an operation whose blast radius depends on the current working directory, target path, or active processes.`
          : `The transcript describes a binary framing mistake before confirming how working implementations behave. The phenomenon is a reasoning shortcut that narrowed the design space before existence evidence was checked.`,
        confidence: risky ? 0.87 : 0.84,
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        evidence: [turnEvidence(event.session_id, event.seq, risky ? 'risky command cue' : 'binary framing cue')],
      }),
    );
  }
  return out;
}

export async function runRulesCandidate(
  analyst: AnalystCandidate,
  options: RunAnalystOptions,
): Promise<AnalystFindingDraft[]> {
  const sessions = await listTargetSessions(options);
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const events = await listEventsForSessions([...bySession.keys()], options);
  return [
    ...detectFailureLoops(analyst, bySession, events, options),
    ...(await detectUnattributedDiff(analyst, options)),
    ...detectExcessCost(analyst, sessions, options),
    ...detectRiskyActions(analyst, bySession, events, options),
  ];
}

function eventsBySession(events: EventRow[]): Map<string, EventRow[]> {
  const bySession = new Map<string, EventRow[]>();
  for (const event of events) {
    if (!bySession.has(event.session_id)) bySession.set(event.session_id, []);
    bySession.get(event.session_id)!.push(event);
  }
  return bySession;
}

function detectScopedFailure(
  analyst: AnalystCandidate,
  session: SessionRow,
  failed: EventRow[],
  options: RunAnalystOptions,
): AnalystFindingDraft[] {
  const scoped = failed.find((event) => event.seq === options.turn?.seq);
  if (!scoped) return [];
  return [
    makeFinding({
      analyst,
      detector: 'failed_turn',
      kind: 'failure_loop',
      title: `Failed command at turn ${scoped.seq}`,
      body: `The selected turn has a non-zero command result. The observable issue is a failed execution step at the requested coordinate, which can be reviewed without broadening the analysis scope.`,
      confidence: 0.91,
      projectId: session.project_id,
      harnessVersionId: session.harness_version_id,
      evidence: [turnEvidence(session.id, scoped.seq, 'selected failed turn')],
    }),
  ];
}

function detectRepeatedFailedCommands(
  analyst: AnalystCandidate,
  session: SessionRow,
  failed: EventRow[],
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  const byCommand = new Map<string, EventRow[]>();
  for (const event of failed) {
    const normalized = normalizeCommand(event.command || event.title);
    if (!normalized) continue;
    if (!byCommand.has(normalized)) byCommand.set(normalized, []);
    byCommand.get(normalized)!.push(event);
  }
  for (const [command, items] of byCommand) {
    if (items.length < 3) continue;
    const first = items[0];
    out.push(
      makeFinding({
        analyst,
        detector: 'repeated_failed_command',
        kind: 'failure_loop',
        title: `Repeated failed command pattern in ${session.title}`,
        body: `The transcript contains ${items.length} non-zero executions of the same command pattern (${shorten(command, 120)}). The phenomenon is a repeated failed execution loop rather than an isolated failure.`,
        confidence: Math.min(0.97, 0.82 + items.length * 0.02),
        projectId: session.project_id,
        harnessVersionId: session.harness_version_id,
        evidence: [
          turnEvidence(session.id, first.seq, 'first failed command in repeated pattern'),
          ...items.slice(1, 4).map((event) => turnEvidence(session.id, event.seq, 'later failed command in repeated pattern')),
        ],
      }),
    );
  }
  return out;
}

function detectFailureCues(
  analyst: AnalystCandidate,
  session: SessionRow,
  sessionEvents: EventRow[],
): AnalystFindingDraft[] {
  const out: AnalystFindingDraft[] = [];
  const seenCueDetectors = new Set<string>();
  const cueEvents = sessionEvents.filter((event) => {
    const text = eventText(event);
    return DATA_DEPENDENT_FLAKE.test(text) || SELF_SUFFICIENT_FIXTURE.test(text) || PORT_COLLISION.test(text);
  });
  for (const event of cueEvents) {
    const finding = failureCueFinding(analyst, session, event, seenCueDetectors);
    if (finding) out.push(finding);
    if (seenCueDetectors.size >= 3) break;
  }
  return out;
}

function failureCueFinding(
  analyst: AnalystCandidate,
  session: SessionRow,
  event: EventRow,
  seenCueDetectors: Set<string>,
): AnalystFindingDraft | undefined {
  const text = eventText(event);
  const fixture = SELF_SUFFICIENT_FIXTURE.test(text);
  const portCollision = PORT_COLLISION.test(text);
  const detector = fixture ? 'self_sufficient_fixture_cue' : portCollision ? 'port_collision_cue' : 'data_dependent_flake_cue';
  if (seenCueDetectors.has(detector)) return undefined;
  seenCueDetectors.add(detector);
  return makeFinding({
    analyst,
    detector,
    kind: 'failure_loop',
    title: fixture
      ? `Fixture-only validation cue in ${session.title}`
      : portCollision
        ? `Port collision failure cue in ${session.title}`
        : `Data-dependent failure cue in ${session.title}`,
    body: fixture
      ? `The transcript describes a validation path that passed fixture-like checks while real data behavior diverged. The phenomenon is a self-contained verification loop that did not cover the observed production-shaped data.`
      : portCollision
        ? `The transcript shows an EADDRINUSE or address-in-use failure. The phenomenon is a local runtime port collision, not stable product behavior.`
        : `The transcript calls out a failure as data-dependent or environment-dependent. The phenomenon is a test result that changed with the selected data or occupied runtime resource, not a stable product behavior.`,
    confidence: fixture ? 0.9 : portCollision ? 0.89 : 0.88,
    projectId: session.project_id,
    harnessVersionId: session.harness_version_id,
    evidence: [turnEvidence(session.id, event.seq, fixture ? 'fixture/self-sufficiency cue' : portCollision ? 'port collision cue' : 'data-dependent failure cue')],
  });
}
