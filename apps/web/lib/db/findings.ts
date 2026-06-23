import type {
  Finding,
  FindingBacklogStatus,
  FindingEvidence,
  FindingKind,
  FindingVerdict,
  FindingVerdictValue,
} from '../types';
import { queryOne, queryRows } from '../db.query';
import { attachEvidenceExcerpts } from './finding-evidence';
import {
  type FindingEvidenceRow,
  type FindingRow,
  type FindingVerdictRow,
  toFinding,
  toFindingEvidence,
  toFindingVerdict,
} from './finding-rows';

export async function listFindings(): Promise<Finding[]> {
  const rows = await queryRows<FindingRow>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id)
              id, finding_id, verdict, reason, decided_at, decided_by
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.id, f.created_at, f.analyst, f.kind, f.title, f.body, f.analysis, f.confidence,
            f.harness_version_id, f.project_id, f.backlog_status, f.backlog_actor,
            hv.provider AS harness_provider,
            hv.content_hash AS harness_content_hash,
            hv.git_commit AS harness_git_commit,
            v.id AS verdict_id,
            v.verdict,
            v.reason,
            v.decided_at,
            v.decided_by
       FROM findings f
       LEFT JOIN harness_versions hv ON hv.id = f.harness_version_id
       LEFT JOIN latest_verdict v ON v.finding_id = f.id
      ORDER BY
            CASE WHEN v.id IS NULL THEN 0 ELSE 1 END ASC,
            f.confidence DESC,
            f.created_at DESC,
            f.id DESC`,
  );
  if (rows.length === 0) return [];

  const evidenceRows = await queryRows<FindingEvidenceRow>(
    `SELECT id, finding_id, subject_kind, session_id, locator, subject_id, note
       FROM finding_evidence
      WHERE finding_id = ANY($1::int[])
      ORDER BY finding_id ASC, id ASC`,
    [rows.map((row) => row.id)],
  );
  const allEvidence = evidenceRows.map(toFindingEvidence);
  const findingKindById = new Map<number, FindingKind>(
    rows.map((row) => [row.id, row.kind as FindingKind]),
  );
  await attachEvidenceExcerpts(allEvidence, findingKindById);

  const evidenceByFinding = new Map<number, FindingEvidence[]>();
  for (const item of allEvidence) {
    const arr = evidenceByFinding.get(item.findingId);
    if (arr) arr.push(item);
    else evidenceByFinding.set(item.findingId, [item]);
  }

  return rows.map((row) => toFinding(row, evidenceByFinding.get(row.id) ?? []));
}

// ---- finding writes --------------------------------------------------------

export async function insertFindingVerdict(
  findingId: number,
  verdict: FindingVerdictValue,
  reason: string | null,
): Promise<FindingVerdict | undefined> {
  const row = await queryOne<FindingVerdictRow>(
    `INSERT INTO finding_verdicts (finding_id, verdict, reason)
     VALUES ($1, $2, $3)
     RETURNING id, finding_id, verdict, reason, decided_at, decided_by`,
    [findingId, verdict, reason],
  );
  return row ? toFindingVerdict(row) : undefined;
}

export async function deleteFindingVerdict(findingId: number, verdictId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `DELETE FROM finding_verdicts
      WHERE finding_id = $1
        AND id = $2
      RETURNING id`,
    [findingId, verdictId],
  );
  return Boolean(row);
}

export async function updateFindingBacklogStatus(
  findingId: number,
  backlogStatus: FindingBacklogStatus | null,
): Promise<{ backlogStatus: FindingBacklogStatus | null; backlogActor: string | null } | undefined> {
  const row = await queryOne<{ backlog_status: string | null; backlog_actor: string | null }>(
    `UPDATE findings
        SET backlog_status = $2,
            backlog_actor = CASE WHEN $2::text IS NULL THEN NULL ELSE 'user' END
      WHERE id = $1
      RETURNING backlog_status, backlog_actor`,
    [findingId, backlogStatus],
  );
  return row
    ? {
        backlogStatus: row.backlog_status as FindingBacklogStatus | null,
        backlogActor: row.backlog_actor,
      }
    : undefined;
}

export async function updateFindingAnalysisIfMissing(
  findingId: number,
  analysis: Record<string, unknown>,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `UPDATE findings
        SET analysis = $2::jsonb
      WHERE id = $1
        AND analysis IS NULL
      RETURNING id`,
    [findingId, analysis],
  );
  return Boolean(row);
}
