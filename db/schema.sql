-- Lathe prototype schema — Phase 1: transcript / Git-diff viewer (read-only).
--
-- Backs the two Phase 1 screens from the proposal's white UI mockups:
--   A) session viewer        (phase-1-session-viewer.png)
--   B) git diff + attribution (phase-1-git-diff-attribution.png)
--
-- Entities follow the Feature-Sliced Design list in the proposal addendum:
--   session, transcript-event, git-diff (changed_files + diff_hunks), attribution.
-- Later phases (finding / fixture_run / harness_version / decision_trace) are
-- intentionally NOT created here — Phase 1 is observation only.
--
-- snake_case columns; the db layer maps to camelCase (see lib/types.ts).

PRAGMA foreign_keys = ON;

-- A recorded coding-agent session (one run over a repository).
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,        -- ses_2026-06-04_lathe-rebuild
  project        TEXT NOT NULL,           -- "LLMWiki / lathe"
  title          TEXT NOT NULL,           -- "Lathe rebuild from scratch"
  runner         TEXT NOT NULL,           -- claude-code | codex | cursor
  model          TEXT,                    -- claude-opus-4-8
  status         TEXT NOT NULL,           -- done | running | failed
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  duration_ms    INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  tool_count     INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,
  bash_count     INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,   -- tool calls that returned non-zero / error events
  token_usage    INTEGER NOT NULL DEFAULT 0,
  token_in       INTEGER NOT NULL DEFAULT 0,   -- real input tokens (sum)
  token_out      INTEGER NOT NULL DEFAULT 0,   -- real output tokens (sum)
  git_branch     TEXT,                         -- real gitBranch from the transcript
  commit_count   INTEGER NOT NULL DEFAULT 0,   -- real count of git-commit events
  cost_usd       REAL,
  summary        TEXT,
  seq            INTEGER NOT NULL DEFAULT 0  -- ordering in the session list
);

-- Append-only transcript events (the timeline of a session).
CREATE TABLE IF NOT EXISTS transcript_events (
  id          TEXT PRIMARY KEY,           -- evt_0001
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,           -- position in timeline
  ts          TEXT NOT NULL,              -- HH:MM:SS
  type        TEXT NOT NULL,              -- user_message | assistant_message | file_read |
                                          -- file_edit | file_write | bash | subagent |
                                          -- skill | commit | test | error | todo
  actor       TEXT NOT NULL,              -- user | assistant | <subagent name>
  title       TEXT NOT NULL,              -- short label / message preview
  body        TEXT,                       -- full content / command output
  file_path   TEXT,                       -- for file_* events
  command     TEXT,                       -- for bash / test
  exit_code   INTEGER,                    -- for bash / test
  duration_ms INTEGER,
  token_usage INTEGER,
  subagent    TEXT,                       -- nesting: subagent / thread name
  meta        TEXT,                       -- json blob (extra fields)
  parent_id   TEXT                        -- launching Agent event id for sub-agent child steps (NULL = top-level)
);
CREATE INDEX IF NOT EXISTS idx_events_parent ON transcript_events(parent_id);

-- Files changed in the session's git diff (left tree of screen B).
CREATE TABLE IF NOT EXISTS changed_files (
  id          TEXT PRIMARY KEY,           -- chf_001
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  path        TEXT NOT NULL,
  status      TEXT NOT NULL,              -- modified | added | deleted | renamed
  additions   INTEGER NOT NULL DEFAULT 0,
  deletions   INTEGER NOT NULL DEFAULT 0,
  language    TEXT,
  seq         INTEGER NOT NULL
);

-- Hunks within a changed file (the diff body of screen B).
CREATE TABLE IF NOT EXISTS diff_hunks (
  id          TEXT PRIMARY KEY,           -- hnk_001
  file_id     TEXT NOT NULL REFERENCES changed_files(id),
  seq         INTEGER NOT NULL,
  header      TEXT NOT NULL,              -- @@ -a,b +c,d @@ context
  content     TEXT NOT NULL              -- lines prefixed with ' ', '+', or '-'
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
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT NOT NULL REFERENCES transcript_events(id),
  path      TEXT NOT NULL,
  role      TEXT NOT NULL                -- read | edit | write
);

-- Minimap markers (bottom density bar of both screens).
CREATE TABLE IF NOT EXISTS annotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  at_seq     INTEGER NOT NULL,           -- position along the timeline
  kind       TEXT NOT NULL,              -- error | test | edit | commit | note
  note       TEXT
);
