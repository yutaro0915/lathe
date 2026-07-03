// Project-scoped run read concern for MCP tools.
// Depends on shared.ts and ./postgres only.

import { queryOne, queryRows } from "./postgres";
import { cleanNumber, cleanString, normalizeLimit } from "./shared";

export interface ListRunsFilter {
  projectId?: string;
  issueNumber?: number;
  loopKind?: string;
  runKeyPrefix?: string;
  hasEscalation?: boolean;
  lastVerdict?: string;
  limit?: number;
  offset?: number;
}

export interface GetRunInput {
  projectId: string;
  runKey: string;
}

export interface McpRunSummary {
  project_id: string;
  run_key: string;
  manifest_path: string;
  source_issue_number: number | null;
  loop_kind: string | null;
  stage_count: number;
  last_stage: string | null;
  last_verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  has_escalation: boolean;
  escalation_path: string | null;
  manifest_sha256: string;
  updated_at: string;
  is_attempt: boolean;
  attempt_number: number | null;
}

export interface McpRunSessionSummary {
  id: string;
  title: string;
  status: string;
  runner: string;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  session_class: string;
}

export interface McpRunStage {
  stage_index: number;
  stage: string;
  session_id: string | null;
  session_status: "found" | "missing" | "no_session_id";
  verdict: string | null;
  backend: string | null;
  backend_model: string | null;
  head_sha: string | null;
  duration_ms: number | null;
  ts: string | null;
  skipped: boolean;
  backend_cost_usd: number | null;
  backend_cost_source: string | null;
  legacy_backend_cost_usd: number | null;
  backend_token_usage: unknown | null;
  session: McpRunSessionSummary | null;
}

export interface McpRun extends McpRunSummary {
  stages: McpRunStage[];
}

interface RunRow {
  project_id: string;
  run_key: string;
  manifest_path: string;
  source_issue_number: number | null;
  loop_kind: string | null;
  stage_count: number;
  last_stage: string | null;
  last_verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  has_escalation: boolean;
  escalation_path: string | null;
  manifest_sha256: string;
  updated_at: string;
}

interface RunStageRow {
  stage_index: number;
  stage: string;
  session_id: string | null;
  verdict: string | null;
  backend: string | null;
  backend_model: string | null;
  head_sha: string | null;
  duration_ms: number | null;
  ts: string | null;
  skipped: boolean;
  backend_cost_usd: number | null;
  backend_cost_source: string | null;
  legacy_backend_cost_usd: number | null;
  backend_token_usage: unknown | null;
  attached_session_id: string | null;
  session_title: string | null;
  session_status: string | null;
  session_runner: string | null;
  session_model: string | null;
  session_cost_usd: number | null;
  session_duration_ms: number | null;
  session_class: string | null;
}

function attemptNumber(runKey: string): number | null {
  const match = /\.attempt(\d+)$/.exec(runKey);
  return match ? Number(match[1]) : null;
}

function toRunSummary(row: RunRow): McpRunSummary {
  const attempt = attemptNumber(row.run_key);
  return {
    project_id: row.project_id,
    run_key: row.run_key,
    manifest_path: row.manifest_path,
    source_issue_number: row.source_issue_number,
    loop_kind: row.loop_kind,
    stage_count: row.stage_count,
    last_stage: row.last_stage,
    last_verdict: row.last_verdict,
    started_at: row.started_at,
    ended_at: row.ended_at,
    has_escalation: row.has_escalation,
    escalation_path: row.escalation_path,
    manifest_sha256: row.manifest_sha256,
    updated_at: row.updated_at,
    is_attempt: attempt !== null,
    attempt_number: attempt,
  };
}

function parseJsonColumn(value: unknown): unknown | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRunStage(row: RunStageRow): McpRunStage {
  if (row.session_id === null) {
    return {
      ...stageBase(row),
      session_status: "no_session_id",
      session: null,
    };
  }
  if (row.attached_session_id === null) {
    return {
      ...stageBase(row),
      session_status: "missing",
      session: null,
    };
  }
  return {
    ...stageBase(row),
    session_status: "found",
    session: {
      id: row.attached_session_id,
      title: row.session_title ?? "",
      status: row.session_status ?? "",
      runner: row.session_runner ?? "",
      model: row.session_model,
      cost_usd: row.session_cost_usd,
      duration_ms: row.session_duration_ms,
      session_class: row.session_class ?? "development",
    },
  };
}

function stageBase(row: RunStageRow) {
  return {
    stage_index: row.stage_index,
    stage: row.stage,
    session_id: row.session_id,
    verdict: row.verdict,
    backend: row.backend,
    backend_model: row.backend_model,
    head_sha: row.head_sha,
    duration_ms: row.duration_ms,
    ts: row.ts,
    skipped: row.skipped,
    backend_cost_usd: row.backend_cost_usd,
    backend_cost_source: row.backend_cost_source,
    legacy_backend_cost_usd: row.legacy_backend_cost_usd,
    backend_token_usage: parseJsonColumn(row.backend_token_usage),
  };
}

function optionalInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

export async function listRuns(filter: ListRunsFilter = {}): Promise<{ total: number; runs: McpRunSummary[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const projectId = cleanString(filter.projectId);
  const issueNumber = optionalInteger(filter.issueNumber);
  const loopKind = cleanString(filter.loopKind);
  const runKeyPrefix = cleanString(filter.runKeyPrefix);
  const lastVerdict = cleanString(filter.lastVerdict);

  if (projectId) where.push(`project_id = ${addParam(projectId)}`);
  if (issueNumber !== undefined) where.push(`source_issue_number = ${addParam(issueNumber)}`);
  if (loopKind) where.push(`loop_kind = ${addParam(loopKind)}`);
  if (runKeyPrefix) where.push(`run_key LIKE ${addParam(`${runKeyPrefix}%`)}`);
  if (typeof filter.hasEscalation === "boolean") where.push(`has_escalation = ${addParam(filter.hasEscalation)}`);
  if (lastVerdict) where.push(`last_verdict = ${addParam(lastVerdict)}`);

  const limit = normalizeLimit(filter.limit);
  const offset = cleanNumber(filter.offset, 0);
  const rows = await queryRows<RunRow & { __total: number }>(
    `SELECT project_id, run_key, manifest_path, source_issue_number, loop_kind,
            stage_count, last_stage, last_verdict, started_at, ended_at,
            has_escalation, escalation_path, manifest_sha256, updated_at,
            COUNT(*) OVER() AS __total
       FROM runs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY started_at DESC NULLS LAST, updated_at DESC, run_key ASC
      LIMIT ${addParam(limit)} OFFSET ${addParam(offset)}`,
    params,
  );
  const total = rows.length > 0 ? Number(rows[0].__total) : 0;
  return { total, runs: rows.map(toRunSummary) };
}

export async function getRun(input: GetRunInput): Promise<McpRun> {
  const projectId = cleanString(input.projectId);
  const runKey = cleanString(input.runKey);
  if (!projectId) throw new Error("project_id is required");
  if (!runKey) throw new Error("run_key is required");

  const run = await queryOne<RunRow>(
    `SELECT project_id, run_key, manifest_path, source_issue_number, loop_kind,
            stage_count, last_stage, last_verdict, started_at, ended_at,
            has_escalation, escalation_path, manifest_sha256, updated_at
       FROM runs
      WHERE project_id = $1 AND run_key = $2`,
    [projectId, runKey],
  );
  if (!run) throw new Error(`run not found: ${projectId}/${runKey}`);

  const stages = await queryRows<RunStageRow>(
    `SELECT rs.stage_index, rs.stage, rs.session_id, rs.verdict,
            rs.backend, rs.backend_model, rs.head_sha, rs.duration_ms,
            rs.ts, rs.skipped, rs.backend_cost_usd, rs.backend_cost_source,
            rs.legacy_backend_cost_usd, rs.backend_token_usage,
            s.id AS attached_session_id, s.title AS session_title,
            s.status AS session_status, s.runner AS session_runner,
            s.model AS session_model, s.cost_usd AS session_cost_usd,
            s.duration_ms AS session_duration_ms, s.session_class
       FROM run_stages rs
       LEFT JOIN sessions s ON s.id = rs.session_id
      WHERE rs.project_id = $1 AND rs.run_key = $2
      ORDER BY rs.stage_index ASC`,
    [projectId, runKey],
  );

  return {
    ...toRunSummary(run),
    stages: stages.map(toRunStage),
  };
}
