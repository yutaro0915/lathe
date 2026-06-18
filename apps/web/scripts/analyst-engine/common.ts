import { stableJson, type FindingKind, type SubmitFindingInput } from '@lathe/domain';

export type AnalystCandidate = 'rules-v1' | 'llm-v1' | 'hybrid-v1';
export type LlmProviderMode = 'none' | 'claude-acp';

export interface TurnScope {
  sessionId: string;
  seq: number;
}

export interface RunAnalystOptions {
  candidate: AnalystCandidate;
  sessionId?: string;
  sessionIds?: string[];
  turn?: TurnScope;
  limit?: number;
  submit?: boolean;
  llmProviderMode?: LlmProviderMode;
  maxLlmSessions?: number;
  source?: 'cli' | 'notify' | 'smoke';
}

export interface AnalystFindingDraft extends SubmitFindingInput {
  detector: string;
}

export interface RunAnalystResult {
  candidate: AnalystCandidate;
  generated: number;
  submitted: number;
  created: number;
  skipped: boolean;
  skipReason?: string;
  findings: Array<{
    findingId?: number;
    created?: boolean;
    kind: FindingKind;
    title: string;
    primarySessionId?: string;
  }>;
  logs: string[];
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  runner: string;
  model: string | null;
  cost_usd: number | null;
  error_count: number;
  edit_count: number;
  turn_count: number;
  harness_version_id: string | null;
  cost_group_size: number;
  cost_group_median_usd: number | null;
  cost_threshold_usd: number;
  cost_anomaly: boolean;
}

export interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  title: string;
  body: string | null;
  command: string | null;
  exit_code: number | null;
}

export interface HunkSignalRow {
  session_id: string;
  project_id: string;
  harness_version_id: string | null;
  hunks: number;
  unattributed: number;
  first_hunk_id: string | null;
  first_path: string | null;
}

export interface KnownIncident {
  id: string;
  label: string;
  session_id: string;
  expected_kind: FindingKind;
  conditions: {
    title_contains?: string;
    event_contains?: string[];
    min_cost_multiplier?: number;
    turn_seq?: number;
  };
}

export interface KnownIncidentFile {
  version: number;
  incidents: KnownIncident[];
}

export interface SmokeResult {
  ok: true;
  recall: Array<{ candidate: AnalystCandidate; found: number; total: number; skipped?: string }>;
  createdFindingsCleaned: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 20;
export const INTERNAL_ANALYST_TAG = 'lathe-internal-analyst';
export const PHENOMENON_LINT_PATTERNS = [
  /(?:CLAUDE\.md|AGENTS\.md)\s*(?:を|に|へ)[^。.\n]*(?:編集|追加|修正|変更|書き換)/i,
  /(?:edit|modify|change|append to)\s+(?:CLAUDE\.md|AGENTS\.md)/i,
];
export const RISKY_COMMAND = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|kill\s+-9|pkill\s+-f|drop\s+database|truncate\s+table|docker\s+compose\s+down)\b/i;
export const SELF_SUFFICIENT_FIXTURE = /(自己充足|fixture).{0,80}(実データ|検出|循環|自己充足|0 行|0件)/i;
export const PORT_COLLISION = /EADDRINUSE|address already in use/i;
export const DATA_DEPENDENT_FLAKE = /(データ依存|flake|flaky|EADDRINUSE|address already in use)/i;
export const BISECTION_ACCIDENT = /(二分法事故|二分法|existence-proof|存在証明).{0,120}(無視|推測|事故|誤り|見落と)/i;

export function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value ?? DEFAULT_LIMIT)));
}

export function shorten(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function primarySessionId(finding: SubmitFindingInput): string | undefined {
  const primary = finding.evidence[0];
  return primary?.sessionId ?? (primary?.subjectKind === 'session' ? primary.subjectId : undefined);
}

export function findingKey(finding: SubmitFindingInput): string {
  const primary = finding.evidence[0];
  return stableJson({
    analyst: finding.analyst,
    kind: finding.kind,
    subjectKind: primary?.subjectKind,
    subjectId: primary?.subjectId ?? '',
    sessionId: primary?.sessionId ?? '',
    locator: primary?.locator ?? {},
  });
}

export function turnEvidence(sessionId: string, seq: number, note: string): SubmitFindingInput['evidence'][number] {
  return {
    subjectKind: 'turn',
    sessionId,
    locator: { seq },
    note,
  };
}

export function sessionEvidence(sessionId: string, note: string): SubmitFindingInput['evidence'][number] {
  return {
    subjectKind: 'session',
    subjectId: sessionId,
    sessionId,
    locator: {},
    note,
  };
}

export function makeFinding(input: {
  analyst: AnalystCandidate;
  detector: string;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  projectId: string;
  harnessVersionId: string | null;
  analysis?: SubmitFindingInput['analysis'] | null;
  evidence: SubmitFindingInput['evidence'];
}): AnalystFindingDraft {
  return {
    analyst: input.analyst,
    kind: input.kind,
    title: shorten(input.title, 500),
    body: shorten(input.body, 20_000),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    projectId: input.projectId,
    harnessVersionId: input.harnessVersionId,
    analysis: input.analysis ?? undefined,
    evidence: input.evidence,
    detector: input.detector,
  };
}

export function eventText(event: EventRow): string {
  return [event.title, event.command, event.body].filter(Boolean).join('\n');
}
