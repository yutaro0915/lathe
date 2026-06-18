export const FINDING_KINDS = ['failure_loop', 'unattributed_diff', 'excess_cost', 'risky_action'] as const;
export const EVIDENCE_SUBJECT_KINDS = ['session', 'event', 'hunk', 'pr', 'turn'] as const;
export const VERDICT_FILTERS = ['accept', 'reject', 'unreviewed', 'any'] as const;

export const FINDING_TITLE_MAX_LENGTH = 500;
export const FINDING_BODY_MAX_LENGTH = 20_000;
export const FINDING_NOTE_MAX_LENGTH = 2_000;
export const FINDING_LOCATOR_MAX_LENGTH = 2_000;
export const FINDING_EVIDENCE_MAX_ITEMS = 50;
export const FINDING_ANALYSIS_FIELD_MAX_LENGTH = 1_200;

export type FindingKind = (typeof FINDING_KINDS)[number];
export type EvidenceSubjectKind = (typeof EVIDENCE_SUBJECT_KINDS)[number];
export type VerdictFilter = (typeof VERDICT_FILTERS)[number];
export type FindingVerdictValue = 'accept' | 'reject';

export interface FindingEvidenceInput {
  subjectKind: EvidenceSubjectKind;
  subjectId?: string;
  sessionId?: string;
  locator?: Record<string, unknown>;
  note?: string;
}

export interface FindingAnalysisInput {
  causeHypothesis?: string | null;
  agentIntent?: string | null;
  impact?: string | null;
}

export interface StoredFindingAnalysis {
  cause_hypothesis: string | null;
  agent_intent: string | null;
  impact: string | null;
}

export interface SubmitFindingInput {
  analyst: string;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  projectId?: string;
  harnessVersionId?: string | null;
  analysis?: FindingAnalysisInput | null;
  evidence: FindingEvidenceInput[];
}

export function isFindingKind(value: unknown): value is FindingKind {
  return typeof value === 'string' && (FINDING_KINDS as readonly string[]).includes(value);
}

export function assertFindingKind(value: string): asserts value is FindingKind {
  if (!isFindingKind(value)) {
    throw new Error(`invalid finding kind: ${value}`);
  }
}

export function isEvidenceSubjectKind(value: unknown): value is EvidenceSubjectKind {
  return typeof value === 'string' && (EVIDENCE_SUBJECT_KINDS as readonly string[]).includes(value);
}

export function assertEvidenceSubjectKind(value: string): asserts value is EvidenceSubjectKind {
  if (!isEvidenceSubjectKind(value)) {
    throw new Error(`invalid evidence subject_kind: ${value}`);
  }
}

export const assertSubjectKind = assertEvidenceSubjectKind;

export function isVerdictFilter(value: unknown): value is VerdictFilter {
  return typeof value === 'string' && (VERDICT_FILTERS as readonly string[]).includes(value);
}

export function assertVerdictFilter(value: string): asserts value is VerdictFilter {
  if (!isVerdictFilter(value)) {
    throw new Error(`invalid verdict filter: ${value}`);
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseJsonObject(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function parseLocator(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  return parseJsonObject(value) ?? {};
}

export function cleanAnalysisText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, FINDING_ANALYSIS_FIELD_MAX_LENGTH) : null;
}

export function normalizeAnalysisForStorage(input: FindingAnalysisInput | null | undefined): StoredFindingAnalysis | null {
  if (!input) return null;
  const analysis = {
    cause_hypothesis: cleanAnalysisText(input.causeHypothesis),
    agent_intent: cleanAnalysisText(input.agentIntent),
    impact: cleanAnalysisText(input.impact),
  };
  return analysis.cause_hypothesis || analysis.agent_intent || analysis.impact ? analysis : null;
}

export function parseStoredAnalysis(
  value: string | Record<string, unknown> | null | undefined,
): FindingAnalysisInput | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const analysis = {
    causeHypothesis: cleanAnalysisText(parsed.cause_hypothesis),
    agentIntent: cleanAnalysisText(parsed.agent_intent),
    impact: cleanAnalysisText(parsed.impact),
  };
  return analysis.causeHypothesis || analysis.agentIntent || analysis.impact ? analysis : null;
}
