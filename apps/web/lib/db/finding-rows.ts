import type {
  Finding,
  FindingAnalysis,
  FindingBacklogStatus,
  FindingEvidence,
  FindingKind,
  FindingVerdict,
  FindingVerdictValue,
} from '../types';

export interface FindingRow {
  id: number;
  created_at: string;
  analyst: string;
  kind: string;
  title: string;
  body: string;
  analysis: string | Record<string, unknown> | null;
  confidence: number;
  harness_version_id: string | null;
  project_id: string;
  backlog_status: string | null;
  backlog_actor: string | null;
  harness_provider: string | null;
  harness_content_hash: string | null;
  harness_git_commit: string | null;
  verdict_id: number | null;
  verdict: string | null;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

export interface FindingEvidenceRow {
  id: number;
  finding_id: number;
  subject_kind: string;
  session_id: string | null;
  locator: string | Record<string, unknown> | null;
  subject_id: string | null;
  note: string | null;
}

export interface FindingVerdictRow {
  id: number;
  finding_id: number;
  verdict: string;
  reason: string | null;
  decided_at: string;
  decided_by: string;
}

export function parseLocator(value: FindingEvidenceRow['locator']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toFindingEvidence(r: FindingEvidenceRow): FindingEvidence {
  return {
    id: r.id,
    findingId: r.finding_id,
    subjectKind: r.subject_kind as FindingEvidence['subjectKind'],
    sessionId: r.session_id,
    locator: parseLocator(r.locator),
    subjectId: r.subject_id,
    note: r.note,
    excerpt: null,
  };
}

export function toFindingVerdict(row: FindingVerdictRow): FindingVerdict {
  return {
    id: row.id,
    findingId: row.finding_id,
    verdict: row.verdict as FindingVerdictValue,
    reason: row.reason,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function parseJsonRecord(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function analysisString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toFindingAnalysis(value: FindingRow['analysis']): FindingAnalysis | null {
  const record = parseJsonRecord(value);
  if (!record) return null;
  const analysis: FindingAnalysis = {
    impact: analysisString(record, 'impact'),
    agentIntent: analysisString(record, 'agent_intent'),
    causeHypothesis: analysisString(record, 'cause_hypothesis'),
  };
  return analysis.impact || analysis.agentIntent || analysis.causeHypothesis ? analysis : null;
}

// Read a numeric locator key (analyst-engine writes turn/event evidence as
// {"seq": <event seq>}; older fixtures may use seq under different keys).
export function locatorSeq(locator: Record<string, unknown>): number | null {
  for (const key of ['seq', 'at_seq', 'step']) {
    const value = locator[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function toFinding(row: FindingRow, evidence: FindingEvidence[]): Finding {
  const verdict: FindingVerdict | null =
    row.verdict_id == null || row.verdict == null || row.decided_at == null || row.decided_by == null
      ? null
      : {
          id: row.verdict_id,
          findingId: row.id,
          verdict: row.verdict as FindingVerdictValue,
          reason: row.reason,
          decidedAt: row.decided_at,
          decidedBy: row.decided_by,
        };
  return {
    id: row.id,
    createdAt: row.created_at,
    analyst: row.analyst,
    kind: row.kind as FindingKind,
    title: row.title,
    body: row.body,
    analysis: toFindingAnalysis(row.analysis),
    confidence: row.confidence,
    harnessVersionId: row.harness_version_id,
    harnessProvider: row.harness_provider,
    harnessContentHash: row.harness_content_hash,
    harnessGitCommit: row.harness_git_commit,
    projectId: row.project_id,
    backlogStatus: row.backlog_status as FindingBacklogStatus | null,
    backlogActor: row.backlog_actor,
    evidence,
    verdict,
  };
}
