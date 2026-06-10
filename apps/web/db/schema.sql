-- Lathe prototype schema — Phase 1: transcript / Git-diff viewer (read-only).
--
-- Backs the Phase 1 screens:
--   A) session viewer
--   B) git diff + attribution
--
-- Later phases (finding / fixture_run / harness_version / decision_trace) are
-- intentionally NOT created here — Phase 1 is observation only.
--
-- snake_case columns; the db layer maps to camelCase (see lib/types.ts).

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  project        TEXT NOT NULL,
  title          TEXT NOT NULL,
  runner         TEXT NOT NULL,
  model          TEXT,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  duration_ms    INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  tool_count     INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,
  bash_count     INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  token_usage    INTEGER NOT NULL DEFAULT 0,
  token_in       INTEGER NOT NULL DEFAULT 0,
  token_out      INTEGER NOT NULL DEFAULT 0,
  git_branch     TEXT,
  commit_count   INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION,
  summary        TEXT,
  seq            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transcript_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  file_path   TEXT,
  command     TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  token_usage INTEGER,
  subagent    TEXT,
  meta        JSONB,
  parent_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_parent ON transcript_events(parent_id);

CREATE TABLE IF NOT EXISTS changed_files (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  path        TEXT NOT NULL,
  status      TEXT NOT NULL,
  additions   INTEGER NOT NULL DEFAULT 0,
  deletions   INTEGER NOT NULL DEFAULT 0,
  language    TEXT,
  seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS diff_hunks (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES changed_files(id),
  seq         INTEGER NOT NULL,
  header      TEXT NOT NULL,
  content     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attributions (
  id          TEXT PRIMARY KEY,
  hunk_id     TEXT NOT NULL REFERENCES diff_hunks(id),
  event_id    TEXT REFERENCES transcript_events(id),
  confidence  TEXT NOT NULL,
  method      TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS event_files (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES transcript_events(id),
  path      TEXT NOT NULL,
  role      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  at_seq     INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  note       TEXT
);
