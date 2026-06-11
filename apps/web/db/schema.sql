-- Lathe prototype schema — Phase 1: transcript / Git-diff viewer (read-only).
--
-- Backs the Phase 1 screens:
--   A) session viewer
--   B) git diff + attribution
--
-- Entities: session, transcript-event, git-diff (changed_files + diff_hunks),
-- attribution.
-- Later phases (finding / fixture_run / harness_version / decision_trace) are
-- intentionally NOT created here — Phase 1 is observation only.
--
-- snake_case columns; the db layer maps to camelCase (see lib/types.ts).

-- A repository-level identity. `id` is the canonical key from ADR 0002:
-- normalized git remote URL when available (for example github.com/owner/repo),
-- with a local fallback only for historical/uninitialized transcripts.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  git_remote   TEXT,
  cwd_hint     TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A recorded coding-agent session (one run over a repository).
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,        -- session id from the transcript
  project_id     TEXT NOT NULL REFERENCES projects(id),
  project        TEXT NOT NULL,           -- repository / project display bucket
  title          TEXT NOT NULL,           -- session title or first user message
  runner         TEXT NOT NULL,           -- claude-code | codex | cursor
  model          TEXT,                    -- provider model id when available
  status         TEXT NOT NULL,           -- done | running | failed
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  duration_ms    INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  tool_count     INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,
  bash_count     INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,   -- non-zero tool calls / error events
  token_usage    INTEGER NOT NULL DEFAULT 0,
  token_in       INTEGER NOT NULL DEFAULT 0,   -- real input tokens when known
  token_out      INTEGER NOT NULL DEFAULT 0,   -- real output tokens when known
  git_branch     TEXT,                         -- git branch from transcript metadata
  commit_count   INTEGER NOT NULL DEFAULT 0,   -- count of commit events
  cost_usd       DOUBLE PRECISION,
  summary        TEXT,
  seq            INTEGER NOT NULL DEFAULT 0    -- ordering in the session list
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

-- Append-only transcript events (the timeline of a session).
CREATE TABLE IF NOT EXISTS transcript_events (
  id          TEXT PRIMARY KEY,           -- globally unique event id
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,           -- position in timeline
  ts          TEXT NOT NULL,              -- display timestamp
  type        TEXT NOT NULL,              -- user_message | assistant_message | thinking |
                                          -- file_read | file_edit | file_write | bash |
                                          -- subagent | skill | memory | hook | commit |
                                          -- test | error | todo
  actor       TEXT NOT NULL,              -- user | assistant | subagent label
  title       TEXT NOT NULL,              -- short label / message preview
  body        TEXT,                       -- full content / command output
  file_path   TEXT,                       -- for file_* and inferred read events
  command     TEXT,                       -- for bash / test / commit events
  exit_code   INTEGER,                    -- for bash / test / commit events
  duration_ms INTEGER,
  token_usage INTEGER,
  subagent    TEXT,                       -- nesting: subagent / thread name
  meta        JSONB,                      -- provider-specific extra fields
  parent_id   TEXT                        -- launcher event id for sub-agent child steps
);
CREATE INDEX IF NOT EXISTS idx_events_parent ON transcript_events(parent_id);

-- Files changed in the session's git diff (left tree of the diff screen).
CREATE TABLE IF NOT EXISTS changed_files (
  id          TEXT PRIMARY KEY,           -- changed-file id scoped to a session
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  path        TEXT NOT NULL,
  status      TEXT NOT NULL,              -- modified | added | deleted | renamed
  additions   INTEGER NOT NULL DEFAULT 0,
  deletions   INTEGER NOT NULL DEFAULT 0,
  language    TEXT,
  seq         INTEGER NOT NULL
);

-- Hunks within a changed file (the diff body).
CREATE TABLE IF NOT EXISTS diff_hunks (
  id          TEXT PRIMARY KEY,           -- hunk id scoped to a changed file
  file_id     TEXT NOT NULL REFERENCES changed_files(id),
  seq         INTEGER NOT NULL,
  header      TEXT NOT NULL,              -- @@ -a,b +c,d @@ context
  content     TEXT NOT NULL               -- lines prefixed with ' ', '+', or '-'
);

-- Attribution: which event produced which hunk, and the confidence.
-- This is the core Phase 1 contribution (diff -> event linkage).
CREATE TABLE IF NOT EXISTS attributions (
  id          TEXT PRIMARY KEY,
  hunk_id     TEXT NOT NULL REFERENCES diff_hunks(id),
  event_id    TEXT REFERENCES transcript_events(id),  -- NULL when unattributed
  confidence  TEXT NOT NULL,             -- high | medium | unattributed
  method      TEXT NOT NULL,             -- edit_event | shell_inferred | external | dirty_worktree
  note        TEXT
);

-- Files referenced/touched by an event (right-panel "Linked files").
CREATE TABLE IF NOT EXISTS event_files (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES transcript_events(id),
  path      TEXT NOT NULL,
  role      TEXT NOT NULL                -- read | edit | write
);

-- Minimap markers (bottom density bar of timeline/diff screens).
CREATE TABLE IF NOT EXISTS annotations (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  at_seq     INTEGER NOT NULL,           -- position along the timeline
  kind       TEXT NOT NULL,              -- error | test | edit | commit | note
  note       TEXT
);

-- Commit SHAs observed in a session transcript. Populated by provider commit
-- event parsing in the next G1 item.
CREATE TABLE IF NOT EXISTS session_commits (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sha        TEXT NOT NULL,
  event_id   TEXT REFERENCES transcript_events(id) ON DELETE SET NULL,
  source     TEXT NOT NULL DEFAULT 'commit_event',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_session_commits_sha ON session_commits(sha);

-- Pull requests imported from the read-only GitHub API.
CREATE TABLE IF NOT EXISTS pull_requests (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,
  node_id          TEXT,
  title            TEXT NOT NULL,
  body             TEXT,
  state            TEXT NOT NULL,
  url              TEXT NOT NULL,
  author_login     TEXT,
  head_ref_name    TEXT,
  head_sha         TEXT,
  base_ref_name    TEXT,
  additions        INTEGER NOT NULL DEFAULT 0,
  deletions        INTEGER NOT NULL DEFAULT 0,
  changed_files    INTEGER NOT NULL DEFAULT 0,
  review_count     INTEGER NOT NULL DEFAULT 0,
  reviews          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  merged_at        TEXT,
  synced_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pull_requests_project_state ON pull_requests(project_id, state);
CREATE INDEX IF NOT EXISTS idx_pull_requests_head_ref ON pull_requests(project_id, head_ref_name);

CREATE TABLE IF NOT EXISTS pr_commits (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  sha          TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (pr_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_pr_commits_sha ON pr_commits(sha);

-- Incremental GitHub polling state. The ETag column is for the REST
-- issues?since= path described in ADR 0006.
CREATE TABLE IF NOT EXISTS github_pr_sync_state (
  project_id          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repo_full_name      TEXT NOT NULL,
  issues_etag         TEXT,
  last_issue_since    TEXT,
  last_backfill_at    TEXT,
  last_incremental_at TEXT,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
