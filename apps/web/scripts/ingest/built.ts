import type {
  AnnotationKind,
  AttributionMethod,
  Confidence,
  EventFileRole,
  EventType,
  FileStatus,
  Runner,
  SessionStatus,
} from '../../lib/types';
import type { BuiltSessionCommit } from './commit-sha';

export interface BuiltSession {
  id: string;
  projectId: string;
  project: string;
  projectGitRemote: string | null;
  projectCwdHint: string | null;
  title: string;
  runner: Runner;
  model: string | null;
  status: SessionStatus;
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
  summary: string | null;
  harness_version_id: string | null;
  parent_session_id: string | null;
  spawned_by_seq: number | null;
  seq: number;
  session_class: string;
  _startMs?: number;
}

export interface BuiltEvent {
  id: string;
  session_id: string;
  seq: number;
  ts: string;
  type: EventType;
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
  parent_id?: string | null;
}

export interface BuiltEventFile {
  event_id: string;
  path: string;
  role: EventFileRole;
}

export interface BuiltChangedFile {
  id: string;
  session_id: string;
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  language: string | null;
  seq: number;
}

export interface BuiltHunk {
  id: string;
  file_id: string;
  seq: number;
  header: string;
  content: string;
}

export interface BuiltAttribution {
  id: string;
  hunk_id: string;
  event_id: string | null;
  confidence: Confidence;
  method: AttributionMethod;
  note: string | null;
}

export interface BuiltAnnotation {
  session_id: string;
  at_seq: number;
  kind: AnnotationKind;
  note: string | null;
}

export interface Built {
  session: BuiltSession;
  events: BuiltEvent[];
  sessionCommits: BuiltSessionCommit[];
  commitShaMissCount: number;
  eventFiles: BuiltEventFile[];
  changedFiles: BuiltChangedFile[];
  hunks: BuiltHunk[];
  attributions: BuiltAttribution[];
  annotations: BuiltAnnotation[];
}
