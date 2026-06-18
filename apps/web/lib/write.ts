import {
  deleteFindingVerdict,
  insertFindingVerdict,
  updateFindingAnalysisIfMissing,
} from './db';
import type { FindingVerdict, FindingVerdictValue } from './types';

export interface RecordFindingVerdictInput {
  findingId: number;
  verdict: FindingVerdictValue;
  reason?: string | null;
}

export interface UndoFindingVerdictInput {
  findingId: number;
  verdictId: number;
}

export async function recordFindingVerdict(
  input: RecordFindingVerdictInput,
): Promise<FindingVerdict | undefined> {
  const reason = input.reason?.trim() || null;
  return insertFindingVerdict(input.findingId, input.verdict, reason);
}

export async function undoFindingVerdict(input: UndoFindingVerdictInput): Promise<boolean> {
  return deleteFindingVerdict(input.findingId, input.verdictId);
}

export async function backfillFindingAnalysisIfMissing(
  findingId: number,
  analysis: Record<string, unknown>,
): Promise<boolean> {
  return updateFindingAnalysisIfMissing(findingId, analysis);
}
