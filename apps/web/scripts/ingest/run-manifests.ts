import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool, PoolClient } from 'pg';

import { resolveProjectIdentity, type ProjectIdentity } from './project';

export const RUN_MANIFEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  project_id           TEXT NOT NULL REFERENCES projects(id),
  run_key              TEXT NOT NULL,
  manifest_path        TEXT NOT NULL,
  source_issue_number  INTEGER,
  loop_kind            TEXT,
  stage_count          INTEGER NOT NULL DEFAULT 0,
  last_stage           TEXT,
  last_verdict         TEXT,
  started_at           TEXT,
  ended_at             TEXT,
  has_escalation       BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_path      TEXT,
  manifest_sha256      TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, run_key)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_updated ON runs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_source_issue ON runs(project_id, source_issue_number);

CREATE TABLE IF NOT EXISTS run_stages (
  project_id              TEXT NOT NULL,
  run_key                 TEXT NOT NULL,
  stage_index             INTEGER NOT NULL,
  stage                   TEXT NOT NULL,
  session_id              TEXT,
  verdict                 TEXT,
  backend                 TEXT,
  backend_model           TEXT,
  head_sha                TEXT,
  duration_ms             BIGINT,
  ts                      TEXT,
  skipped                 BOOLEAN NOT NULL DEFAULT FALSE,
  backend_cost_usd        DOUBLE PRECISION,
  backend_cost_source     TEXT,
  legacy_backend_cost_usd DOUBLE PRECISION,
  backend_token_usage     JSONB,
  PRIMARY KEY (project_id, run_key, stage_index),
  FOREIGN KEY (project_id, run_key)
    REFERENCES runs(project_id, run_key)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_stages_session ON run_stages(session_id);
CREATE INDEX IF NOT EXISTS idx_run_stages_backend ON run_stages(project_id, backend);
`;

export interface RunRow {
  projectId: string;
  runKey: string;
  manifestPath: string;
  sourceIssueNumber: number | null;
  loopKind: string | null;
  stageCount: number;
  lastStage: string | null;
  lastVerdict: string | null;
  startedAt: string | null;
  endedAt: string | null;
  hasEscalation: boolean;
  escalationPath: string | null;
  manifestSha256: string;
}

export interface RunStageRow {
  projectId: string;
  runKey: string;
  stageIndex: number;
  stage: string;
  sessionId: string | null;
  verdict: string | null;
  backend: string | null;
  backendModel: string | null;
  headSha: string | null;
  durationMs: number | null;
  ts: string | null;
  skipped: boolean;
  backendCostUsd: number | null;
  backendCostSource: string | null;
  legacyBackendCostUsd: number | null;
  backendTokenUsage: unknown | null;
}

export interface DerivedRunManifestRows {
  run: RunRow;
  stages: RunStageRow[];
}

export interface SyncRunManifestsOptions {
  cwd?: string;
  repoRoot?: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n == null ? null : Math.trunc(n);
}

function sourceIssueNumber(runKey: string, manifest: JsonObject): number | null {
  // Task-keyed runs (ADR 0025 TASK-1.1) never carry a GitHub issue number:
  // no `manifest.issue` field is written for them (see buildManifest), and
  // `task-<slug>` never matches the issue/plan filename fallback below.
  const explicit = integerOrNull(manifest.issue);
  if (explicit != null) return explicit;
  const match = /^(?:issue|plan)-(\d+)(?:\.attempt\d+)?$/.exec(runKey);
  return match ? Number(match[1]) : null;
}

function loopKind(runKey: string): string | null {
  if (/^issue-\d+(?:\.attempt\d+)?$/.test(runKey)) return 'issue';
  if (/^plan-\d+(?:\.attempt\d+)?$/.test(runKey)) return 'plan';
  if (/^meta-/.test(runKey)) return 'meta';
  if (/^task-/.test(runKey)) return 'task';
  return null;
}

function relativeToRepo(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

export function findRepoRoot(startCwd = process.cwd()): string {
  let current = path.resolve(startCwd);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startCwd);
    current = parent;
  }
}

export function parseRunKey(manifestPath: string): string {
  return path.basename(manifestPath, '.json');
}

export function discoverRunManifestFiles(repoRoot: string): string[] {
  const runsDir = path.join(repoRoot, '.lathe', 'runs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
}

export function deriveRunManifestRows({
  repoRoot,
  projectId,
  manifestPath,
}: {
  repoRoot: string;
  projectId: string;
  manifestPath: string;
}): DerivedRunManifestRows {
  const text = fs.readFileSync(manifestPath, 'utf8');
  const parsed = asObject(JSON.parse(text));
  if (!parsed) throw new Error(`run manifest must be an object: ${manifestPath}`);
  if (!Array.isArray(parsed.stages)) throw new Error(`run manifest stages must be an array: ${manifestPath}`);

  const runKey = parseRunKey(manifestPath);
  const stages = parsed.stages.map((rawStage, index): RunStageRow => {
    const stage = asObject(rawStage) ?? {};
    return {
      projectId,
      runKey,
      stageIndex: index,
      stage: stringOrNull(stage.stage) ?? '(unknown)',
      sessionId: stringOrNull(stage.session_id),
      verdict: stringOrNull(stage.verdict),
      backend: stringOrNull(stage.backend),
      backendModel: stringOrNull(stage.backend_model),
      headSha: stringOrNull(stage.head_sha),
      durationMs: integerOrNull(stage.duration_ms),
      ts: stringOrNull(stage.ts),
      skipped: stage.skipped === true,
      backendCostUsd: numberOrNull(stage.backend_cost_usd),
      backendCostSource: stringOrNull(stage.backend_cost_source),
      legacyBackendCostUsd: numberOrNull(stage.cost_usd),
      backendTokenUsage: stage.backend_token_usage ?? null,
    };
  });

  const firstStage = stages[0] ?? null;
  const lastStage = stages.at(-1) ?? null;
  const escalationPath = path.join(path.dirname(manifestPath), `${runKey}.escalation.md`);
  const relativeEscalationPath = fs.existsSync(escalationPath) ? relativeToRepo(repoRoot, escalationPath) : null;
  const hasEscalation = relativeEscalationPath != null || stages.some((stage) => stage.verdict === 'ESCALATE');

  return {
    run: {
      projectId,
      runKey,
      manifestPath: relativeToRepo(repoRoot, manifestPath),
      sourceIssueNumber: sourceIssueNumber(runKey, parsed),
      loopKind: loopKind(runKey),
      stageCount: stages.length,
      lastStage: lastStage?.stage ?? null,
      lastVerdict: lastStage?.verdict ?? null,
      startedAt: firstStage?.ts ?? null,
      endedAt: lastStage?.ts ?? null,
      hasEscalation,
      escalationPath: relativeEscalationPath,
      manifestSha256: crypto.createHash('sha256').update(text).digest('hex'),
    },
    stages,
  };
}

async function upsertProject(client: PoolClient, identity: ProjectIdentity): Promise<void> {
  await client.query(
    `INSERT INTO projects (id, display_name, git_remote, cwd_hint, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       git_remote = EXCLUDED.git_remote,
       cwd_hint = EXCLUDED.cwd_hint,
       updated_at = CURRENT_TIMESTAMP`,
    [identity.id, identity.displayName, identity.gitRemote, identity.cwdHint],
  );
}

async function upsertRun(client: PoolClient, row: RunRow): Promise<void> {
  await client.query(
    `INSERT INTO runs (
       project_id, run_key, manifest_path, source_issue_number, loop_kind,
       stage_count, last_stage, last_verdict, started_at, ended_at,
       has_escalation, escalation_path, manifest_sha256, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, CURRENT_TIMESTAMP
     )
     ON CONFLICT (project_id, run_key) DO UPDATE SET
       manifest_path = EXCLUDED.manifest_path,
       source_issue_number = EXCLUDED.source_issue_number,
       loop_kind = EXCLUDED.loop_kind,
       stage_count = EXCLUDED.stage_count,
       last_stage = EXCLUDED.last_stage,
       last_verdict = EXCLUDED.last_verdict,
       started_at = EXCLUDED.started_at,
       ended_at = EXCLUDED.ended_at,
       has_escalation = EXCLUDED.has_escalation,
       escalation_path = EXCLUDED.escalation_path,
       manifest_sha256 = EXCLUDED.manifest_sha256,
       updated_at = CURRENT_TIMESTAMP`,
    [
      row.projectId,
      row.runKey,
      row.manifestPath,
      row.sourceIssueNumber,
      row.loopKind,
      row.stageCount,
      row.lastStage,
      row.lastVerdict,
      row.startedAt,
      row.endedAt,
      row.hasEscalation,
      row.escalationPath,
      row.manifestSha256,
    ],
  );
}

async function replaceRunStages(client: PoolClient, run: RunRow, stages: RunStageRow[]): Promise<void> {
  await client.query(
    `DELETE FROM run_stages WHERE project_id = $1 AND run_key = $2`,
    [run.projectId, run.runKey],
  );
  for (const stage of stages) {
    await client.query(
      `INSERT INTO run_stages (
         project_id, run_key, stage_index, stage, session_id, verdict,
         backend, backend_model, head_sha, duration_ms, ts, skipped,
         backend_cost_usd, backend_cost_source, legacy_backend_cost_usd,
         backend_token_usage
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16
       )`,
      [
        stage.projectId,
        stage.runKey,
        stage.stageIndex,
        stage.stage,
        stage.sessionId,
        stage.verdict,
        stage.backend,
        stage.backendModel,
        stage.headSha,
        stage.durationMs,
        stage.ts,
        stage.skipped,
        stage.backendCostUsd,
        stage.backendCostSource,
        stage.legacyBackendCostUsd,
        stage.backendTokenUsage,
      ],
    );
  }
}

export async function syncRunManifests(
  pool: Pool,
  options: SyncRunManifestsOptions = {},
): Promise<{ projectId: string; runsUpserted: number; runsDeleted: number }> {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : findRepoRoot(options.cwd ?? process.cwd());
  const identity = resolveProjectIdentity(repoRoot, path.basename(repoRoot));
  const manifestFiles = discoverRunManifestFiles(repoRoot);
  const currentRunKeys = manifestFiles.map(parseRunKey);
  const derived = manifestFiles.map((manifestPath) => deriveRunManifestRows({
    repoRoot,
    projectId: identity.id,
    manifestPath,
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertProject(client, identity);
    for (const rows of derived) {
      await upsertRun(client, rows.run);
      await replaceRunStages(client, rows.run, rows.stages);
    }
    const deleteResult = currentRunKeys.length === 0
      ? await client.query(`DELETE FROM runs WHERE project_id = $1`, [identity.id])
      : await client.query(
        `DELETE FROM runs
          WHERE project_id = $1
            AND NOT (run_key = ANY($2::text[]))`,
        [identity.id, currentRunKeys],
      );
    await client.query('COMMIT');
    return {
      projectId: identity.id,
      runsUpserted: derived.length,
      runsDeleted: deleteResult.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
