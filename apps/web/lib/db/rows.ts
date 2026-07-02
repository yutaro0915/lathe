import type {
  Annotation,
  AnnotationKind,
  Attribution,
  AttributionMethod,
  ChangedFile,
  Confidence,
  DiffHunk,
  EventFile,
  EventFileRole,
  EventType,
  FileStatus,
  PullRequest,
  PullRequestState,
  PullRequestSummary,
  Runner,
  Session,
  SessionStatus,
  TranscriptEvent,
} from '../types';
import type { SessionClass } from '../../scripts/ingest/domain/session-class';

export interface SessionRow {
  id: string;
  project: string;
  title: string;
  runner: string;
  model: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  tool_count: number;
  edit_count: number;
  bash_count: number;
  subagent_count: number;
  error_count: number;
  token_usage: number;
  token_in: number;
  token_out: number;
  git_branch: string | null;
  commit_count: number;
  cost_usd: number | null;
  cost_anomaly: boolean;
  cost_anomaly_threshold_usd: number;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  summary: string | null;
  parent_session_id: string | null;
  spawned_by_seq: number | null;
  step_count: number | null;
  seq: number;
  session_class: string;
}

export interface TranscriptEventRow {
  id: string;
  session_id: string;
  seq: number;
  ts: string;
  type: string;
  actor: string;
  title: string;
  body: string | null;
  file_path: string | null;
  command: string | null;
  exit_code: number | null;
  exit_disposition?: string | null;
  duration_ms: number | null;
  token_usage: number | null;
  subagent: string | null;
  meta: string | null;
  parent_id: string | null;
}

export interface ChangedFileRow {
  id: string;
  session_id: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  language: string | null;
  seq: number;
}

export interface DiffHunkRow {
  id: string;
  file_id: string;
  seq: number;
  header: string;
  content: string;
}

export interface AttributionRow {
  id: string;
  hunk_id: string;
  event_id: string | null;
  confidence: string;
  method: string;
  note: string | null;
}

export interface EventFileRow {
  id: number;
  event_id: string;
  path: string;
  role: string;
}

export interface AnnotationRow {
  id: number;
  session_id: string;
  at_seq: number;
  kind: string;
  note: string | null;
}

export interface PullRequestRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  author_login: string | null;
  head_ref_name: string | null;
  head_sha: string | null;
  base_ref_name: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  review_count: number;
  reviews: string | unknown[] | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface PullRequestLinkRow extends PullRequestRow {
  link_method: string;
  source: string;
  pr_updated_at: string;
}

export interface SessionPrSummaryRow {
  session_id: string;
  id: string;
  project_id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  head_ref_name: string | null;
  merged_at: string | null;
  updated_at: string;
  link_method: string;
  source: string;
  pr_updated_at: string;
}

export interface LinkedEventRow extends TranscriptEventRow {
  __confidence: string;
  __method: string;
  __hunk_id: string;
}

export function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    runner: r.runner as Runner,
    model: r.model,
    status: r.status as SessionStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    turnCount: r.turn_count,
    toolCount: r.tool_count,
    editCount: r.edit_count,
    bashCount: r.bash_count,
    subagentCount: r.subagent_count,
    errorCount: r.error_count,
    tokenUsage: r.token_usage,
    tokenIn: r.token_in,
    tokenOut: r.token_out,
    gitBranch: r.git_branch,
    commitCount: r.commit_count,
    costUsd: r.cost_usd,
    costAnomaly: r.cost_anomaly,
    costAnomalyThresholdUsd: r.cost_anomaly_threshold_usd,
    costAnomalyGroupSize: r.cost_anomaly_group_size,
    costAnomalyGroupMedianUsd: r.cost_anomaly_group_median_usd,
    summary: r.summary,
    parentSessionId: r.parent_session_id ?? null,
    spawnedBySeq: r.spawned_by_seq ?? null,
    stepCount: r.step_count ?? 0,
    seq: r.seq,
    sessionClass: (r.session_class ?? 'development') as SessionClass,
  };
}

export function toEvent(r: TranscriptEventRow): TranscriptEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    type: r.type as EventType,
    actor: r.actor,
    title: r.title,
    body: r.body,
    filePath: r.file_path,
    command: r.command,
    exitCode: r.exit_code,
    exitDisposition: r.exit_disposition ?? null,
    durationMs: r.duration_ms,
    tokenUsage: r.token_usage,
    subagent: r.subagent,
    meta: r.meta,
    parentId: r.parent_id,
  };
}

export function toChangedFile(r: ChangedFileRow): ChangedFile {
  return {
    id: r.id,
    sessionId: r.session_id,
    path: r.path,
    status: r.status as FileStatus,
    additions: r.additions,
    deletions: r.deletions,
    language: r.language,
    seq: r.seq,
  };
}

export function toHunk(r: DiffHunkRow): DiffHunk {
  return {
    id: r.id,
    fileId: r.file_id,
    seq: r.seq,
    header: r.header,
    content: r.content,
  };
}

export function toAttribution(r: AttributionRow): Attribution {
  return {
    id: r.id,
    hunkId: r.hunk_id,
    eventId: r.event_id,
    confidence: r.confidence as Confidence,
    method: r.method as AttributionMethod,
    note: r.note,
  };
}

export function toEventFile(r: EventFileRow): EventFile {
  return {
    id: r.id,
    eventId: r.event_id,
    path: r.path,
    role: r.role as EventFileRole,
  };
}

export function toAnnotation(r: AnnotationRow): Annotation {
  return {
    id: r.id,
    sessionId: r.session_id,
    atSeq: r.at_seq,
    kind: r.kind as AnnotationKind,
    note: r.note,
  };
}

function parseReviews(value: PullRequestRow['reviews']): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function toPullRequestSummary(r: PullRequestRow | SessionPrSummaryRow, linkMethod?: string): PullRequestSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    title: r.title,
    state: r.state as PullRequestState,
    url: r.url,
    headRefName: r.head_ref_name,
    baseRefName: 'base_ref_name' in r ? r.base_ref_name : undefined,
    additions: 'additions' in r ? r.additions : undefined,
    deletions: 'deletions' in r ? r.deletions : undefined,
    changedFiles: 'changed_files' in r ? r.changed_files : undefined,
    mergedAt: r.merged_at,
    updatedAt: r.updated_at,
    linkMethod: linkMethod ? (linkMethod as 'sha' | 'branch') : undefined,
  };
}

export function toPullRequest(r: PullRequestRow): PullRequest {
  return {
    ...toPullRequestSummary(r),
    body: r.body,
    authorLogin: r.author_login,
    headSha: r.head_sha,
    baseRefName: r.base_ref_name,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changed_files,
    reviewCount: r.review_count,
    reviews: parseReviews(r.reviews),
    createdAt: r.created_at,
  };
}
