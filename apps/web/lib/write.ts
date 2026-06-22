import {
  deleteFindingVerdict,
  insertFindingVerdict,
  updateFindingBacklogStatus,
  updateFindingAnalysisIfMissing,
} from './db';
import type { FindingBacklogStatus, FindingVerdict, FindingVerdictValue } from './types';

export interface RecordFindingVerdictInput {
  findingId: number;
  verdict: FindingVerdictValue;
  reason?: string | null;
  backlogStatus?: FindingBacklogStatus | null;
}

export interface UndoFindingVerdictInput {
  findingId: number;
  verdictId: number;
}

export interface RecordFindingVerdictResult {
  verdict: FindingVerdict;
  backlogStatus: FindingBacklogStatus | null;
  backlogActor: string | null;
}

export async function recordFindingVerdict(
  input: RecordFindingVerdictInput,
): Promise<RecordFindingVerdictResult | undefined> {
  const reason = input.reason?.trim() || null;
  const verdict = await insertFindingVerdict(input.findingId, input.verdict, reason);
  if (!verdict) return undefined;
  const nextBacklog = input.verdict === 'accept' ? input.backlogStatus ?? 'open' : null;
  const backlog = await updateFindingBacklogStatus(input.findingId, nextBacklog);
  return {
    verdict,
    backlogStatus: backlog?.backlogStatus ?? nextBacklog,
    backlogActor: backlog?.backlogActor ?? (nextBacklog ? 'user' : null),
  };
}

export async function undoFindingVerdict(input: UndoFindingVerdictInput): Promise<boolean> {
  const deleted = await deleteFindingVerdict(input.findingId, input.verdictId);
  if (deleted) await updateFindingBacklogStatus(input.findingId, null);
  return deleted;
}

export async function recordFindingBacklogStatus(
  findingId: number,
  backlogStatus: FindingBacklogStatus,
): Promise<{ backlogStatus: FindingBacklogStatus | null; backlogActor: string | null } | undefined> {
  return updateFindingBacklogStatus(findingId, backlogStatus);
}

export async function backfillFindingAnalysisIfMissing(
  findingId: number,
  analysis: Record<string, unknown>,
): Promise<boolean> {
  return updateFindingAnalysisIfMissing(findingId, analysis);
}
