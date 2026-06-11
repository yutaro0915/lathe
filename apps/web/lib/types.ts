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
  | 'todo'
  | 'memory' // a CLAUDE.md / AGENTS.md context file was loaded (harness)
  | 'hook'; // a hook fired (PreToolUse / PostToolUse / Stop … harness)

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
  costAnomaly: boolean;
  costAnomalyThresholdUsd: number;
  costAnomalyGroupSize: number;
  costAnomalyGroupMedianUsd: number | null;
  summary: string | null;
  seq: number;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequestSummary {
  id: string;
  projectId: string;
  number: number;
  title: string;
  state: PullRequestState;
  url: string;
  headRefName: string | null;
  mergedAt: string | null;
  updatedAt: string;
  linkMethod?: 'sha' | 'branch';
}

export interface PullRequest extends PullRequestSummary {
  body: string | null;
  authorLogin: string | null;
  headSha: string | null;
  baseRefName: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewCount: number;
  reviews: unknown[];
  createdAt: string;
}

export interface PullRequestSessionLink {
  session: Session;
  linkMethod: 'sha' | 'branch';
}

export interface PullRequestBundle {
  pullRequest: PullRequest;
  linkedSessions: PullRequestSessionLink[];
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

// ---- cross-session stats (the /stats page) --------------------------------
// Sessions are grouped by their PRIMARY project — the directory (projects/<slug>
// or a top-level hub dir like wiki/memory) where the session changed the most
// files. `sessions.project` is the repo basename (uniformly "LLMWiki" here), so
// the meaningful per-project split is derived from changed-file paths.
export interface ProjectSessionRef {
  id: string;
  title: string;
  model: string | null;
  durationMs: number | null;
  tokens: number;
  cost: number | null;
  errors: number;
}
export interface ProjectStat {
  project: string;
  sessions: number;
  durationMs: number;
  tokens: number;
  cost: number;
  costKnown: boolean; // false → no session under this project was priceable ("—")
  files: number;
  additions: number;
  deletions: number;
  errors: number;
  sessionRefs: ProjectSessionRef[];
}
// A single changed file rolled up across the whole corpus — which file was
// touched, in which project, by how many sessions, and the sessions themselves
// (so a file is traceable back to where the agent worked on it).
export interface FileStat {
  path: string;
  project: string;
  sessions: number;
  additions: number;
  deletions: number;
  sessionRefs: ProjectSessionRef[];
}
export interface UsageCount {
  name: string;
  count: number;
}
export interface ModelStat {
  name: string;
  sessions: number;
  tokens: number;
  cost: number | null; // null when the model isn't priceable (e.g. Codex/GPT) — shown as "—", not $0
}
export interface StatsBundle {
  totals: { sessions: number; durationMs: number; tokens: number; cost: number };
  projects: ProjectStat[];
  files: FileStat[];
  skills: UsageCount[];
  subagentTypes: UsageCount[];
  memory: UsageCount[]; // which CLAUDE.md/AGENTS.md context files were loaded (nested)
  hooks: UsageCount[]; // which hooks fired (by event/name)
  models: ModelStat[];
}

// Everything the client needs to render one session interactively, assembled
// server-side and passed as serializable props (no db access on the client).
export interface SessionBundle {
  session: Session;
  pullRequests: PullRequestSummary[];
  events: TranscriptEvent[];
  typeCounts: Record<string, number>;
  annotations: Annotation[];
  eventFiles: Record<string, EventFile[]>; // keyed by eventId
  changedFiles: ChangedFile[];
  hunks: Record<string, DiffHunk[]>; // keyed by fileId
  attributions: Record<string, Attribution[]>; // keyed by hunkId
  linkedEvents: Record<string, LinkedEvent[]>; // keyed by fileId
}
