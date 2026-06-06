// Domain types for the Lathe prototype — Phase 1 (transcript / Git-diff viewer).
// Mirror db/schema.sql in camelCase. lib/db.ts maps snake_case rows to these.

export type Runner = 'claude-code' | 'codex' | 'cursor';
export type SessionStatus = 'done' | 'running' | 'failed';

export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'thinking'
  | 'file_read'
  | 'file_edit'
  | 'file_write'
  | 'bash'
  | 'subagent'
  | 'skill'
  | 'commit'
  | 'test'
  | 'error'
  | 'todo';

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';
export type Confidence = 'high' | 'medium' | 'unattributed';
export type AttributionMethod =
  | 'edit_event'
  | 'shell_inferred'
  | 'external'
  | 'dirty_worktree';
export type EventFileRole = 'read' | 'edit' | 'write';
export type AnnotationKind = 'error' | 'test' | 'edit' | 'commit' | 'note';

export interface Session {
  id: string;
  project: string;
  title: string;
  runner: Runner;
  model: string | null;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  turnCount: number;
  toolCount: number;
  editCount: number;
  bashCount: number;
  subagentCount: number;
  errorCount: number;
  tokenUsage: number;
  tokenIn: number;
  tokenOut: number;
  gitBranch: string | null;
  commitCount: number;
  costUsd: number | null;
  summary: string | null;
  seq: number;
}

export interface TranscriptEvent {
  id: string;
  sessionId: string;
  seq: number;
  ts: string;
  type: EventType;
  actor: string;
  title: string;
  body: string | null;
  filePath: string | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  tokenUsage: number | null;
  subagent: string | null;
  meta: string | null;
  parentId: string | null; // launching Agent event id for sub-agent child steps
}

export interface ChangedFile {
  id: string;
  sessionId: string;
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  language: string | null;
  seq: number;
}

export interface DiffHunk {
  id: string;
  fileId: string;
  seq: number;
  header: string;
  content: string;
}

export interface Attribution {
  id: string;
  hunkId: string;
  eventId: string | null;
  confidence: Confidence;
  method: AttributionMethod;
  note: string | null;
}

export interface EventFile {
  id: number;
  eventId: string;
  path: string;
  role: EventFileRole;
}

export interface Annotation {
  id: number;
  sessionId: string;
  atSeq: number;
  kind: AnnotationKind;
  note: string | null;
}

// Convenience shape for screen B's "Linked Events" panel.
export interface LinkedEvent {
  event: TranscriptEvent;
  confidence: Confidence;
  method: AttributionMethod;
  hunkId: string;
}

// Everything the client needs to render one session interactively, assembled
// server-side and passed as serializable props (no db access on the client).
export interface SessionBundle {
  session: Session;
  events: TranscriptEvent[];
  typeCounts: Record<string, number>;
  annotations: Annotation[];
  eventFiles: Record<string, EventFile[]>; // keyed by eventId
  changedFiles: ChangedFile[];
  hunks: Record<string, DiffHunk[]>; // keyed by fileId
  attributions: Record<string, Attribution[]>; // keyed by hunkId
  linkedEvents: Record<string, LinkedEvent[]>; // keyed by fileId
}
