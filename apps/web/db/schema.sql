-- Lathe prototype schema — transcript / Git-diff viewer plus Phase 2 analysis
-- persistence.
--
-- Backs the Phase 1 screens:
--   A) session viewer
--   B) git diff + attribution
--
-- Entities: session, transcript-event, git-diff (changed_files + diff_hunks),
-- attribution.
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

-- Phase 2 persistent harness inventory. The provider binding is deliberately
-- shallow: path + providers + provider-subset hash, per ADR 0005.
CREATE TABLE IF NOT EXISTS harness_artifacts (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  path        TEXT NOT NULL,
  providers   TEXT[] NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_harness_artifacts_project ON harness_artifacts(project_id);

CREATE TABLE IF NOT EXISTS harness_versions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  provider     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  git_commit   TEXT,
  UNIQUE (project_id, provider, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_harness_versions_project_provider ON harness_versions(project_id, provider);

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
  token_usage    BIGINT NOT NULL DEFAULT 0,
  token_in       BIGINT NOT NULL DEFAULT 0,    -- real input tokens when known
  token_out      BIGINT NOT NULL DEFAULT 0,    -- real output tokens when known
  git_branch     TEXT,                         -- git branch from transcript metadata
  commit_count   INTEGER NOT NULL DEFAULT 0,   -- count of commit events
  cost_usd       DOUBLE PRECISION,
  summary        TEXT,
  harness_version_id TEXT REFERENCES harness_versions(id) ON DELETE SET NULL,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  spawned_by_seq INTEGER,
  seq            INTEGER NOT NULL DEFAULT 0    -- ordering in the session list
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS harness_version_id TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_harness_version_id_fkey'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_harness_version_id_fkey
      FOREIGN KEY (harness_version_id) REFERENCES harness_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sessions_harness_version ON sessions(harness_version_id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS spawned_by_seq INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_parent_session_id_fkey'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_parent_session_id_fkey
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session ON sessions(parent_session_id);

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
  exit_code        INTEGER,               -- for bash / test / commit events
  exit_disposition TEXT,                  -- na | ok | gate_verdict | probe | no_match | policy_block | failure
  duration_ms INTEGER,
  token_usage BIGINT,
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
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_seq     INTEGER NOT NULL,           -- position along the timeline
  kind       TEXT NOT NULL,              -- error | test | edit | commit | note
  note       TEXT
);
DELETE FROM annotations
 WHERE NOT EXISTS (
   SELECT 1 FROM sessions WHERE sessions.id = annotations.session_id
 );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'annotations_session_id_fkey'
  ) THEN
    ALTER TABLE annotations
      ADD CONSTRAINT annotations_session_id_fkey
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_annotations_session_seq ON annotations(session_id, at_seq);

-- Phase 2 persistent findings. Evidence uses logical coordinates
-- (subject_kind + session_id + locator) instead of FK-ing to derived rows.
CREATE TABLE IF NOT EXISTS findings (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  analyst            TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('failure_loop', 'unattributed_diff', 'excess_cost', 'risky_action')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  confidence         DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  harness_version_id TEXT REFERENCES harness_versions(id) ON DELETE SET NULL,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  analysis           JSONB,
  backlog_status     TEXT CHECK (backlog_status IS NULL OR backlog_status IN ('open', 'addressed', 'dismissed')),
  backlog_actor      TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_project_kind ON findings(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_findings_harness_version ON findings(harness_version_id);

-- Phase 2 deep-dive + improvement-backlog columns. These ALTERs are
-- intentionally idempotent so existing Lathe databases can be upgraded without
-- destructive migration steps.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS analysis JSONB;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS backlog_status TEXT
  CHECK (backlog_status IS NULL OR backlog_status IN ('open', 'addressed', 'dismissed'));
ALTER TABLE findings ADD COLUMN IF NOT EXISTS backlog_actor TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'findings_backlog_status_check'
       AND conrelid = 'findings'::regclass
  ) THEN
    ALTER TABLE findings
      ADD CONSTRAINT findings_backlog_status_check
      CHECK (backlog_status IS NULL OR backlog_status IN ('open', 'addressed', 'dismissed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_findings_backlog_status ON findings(backlog_status);

-- exit_disposition: added 2026-06-29. Idempotent — safe to run on existing DBs.
ALTER TABLE transcript_events ADD COLUMN IF NOT EXISTS exit_disposition TEXT;

CREATE TABLE IF NOT EXISTS finding_evidence (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id   INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('session', 'event', 'hunk', 'pr', 'turn')),
  session_id   TEXT,
  locator      JSONB NOT NULL DEFAULT '{}'::jsonb,
  subject_id   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_finding_evidence_finding ON finding_evidence(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_evidence_logical ON finding_evidence(subject_kind, session_id);

CREATE TABLE IF NOT EXISTS finding_verdicts (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
  reason     TEXT,
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_finding_verdicts_finding ON finding_verdicts(finding_id);

-- chat_threads / chat_messages: the agent chat UI was removed (durable data
-- layer retained). No application code reads or writes these tables; the
-- definitions are kept on purpose so a future chat re-implementation does not
-- require a migration to recreate them. Dropping them now would be a needless
-- migration risk. Do not wire app code to these without re-introducing chat.
CREATE TABLE IF NOT EXISTS chat_threads (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  session_id TEXT,
  finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON chat_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_session ON chat_threads(session_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  body       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  meta       JSONB,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_seq ON chat_messages(thread_id, seq);

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

CREATE OR REPLACE VIEW session_pull_requests AS
WITH sha_links AS (
  SELECT DISTINCT
    sc.session_id,
    pc.pr_id,
    'sha'::TEXT AS link_method,
    'sha'::TEXT AS source,
    pr.updated_at AS pr_updated_at
  FROM session_commits sc
  JOIN pr_commits pc
    ON LENGTH(sc.sha) >= 7
   AND LOWER(pc.sha) LIKE LOWER(sc.sha) || '%'
  JOIN pull_requests pr ON pr.id = pc.pr_id
  JOIN sessions s ON s.id = sc.session_id AND s.project_id = pr.project_id
),
branch_links AS (
  SELECT DISTINCT
    s.id AS session_id,
    pr.id AS pr_id,
    'branch'::TEXT AS link_method,
    'branch'::TEXT AS source,
    pr.updated_at AS pr_updated_at
  FROM sessions s
  JOIN pull_requests pr
    ON pr.project_id = s.project_id
   AND pr.head_ref_name IS NOT NULL
   AND s.git_branch = pr.head_ref_name
  WHERE s.git_branch IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM sha_links sl
      WHERE sl.session_id = s.id
    )
)
SELECT session_id, pr_id, link_method, source, pr_updated_at FROM sha_links
UNION
SELECT session_id, pr_id, link_method, source, pr_updated_at FROM branch_links
ORDER BY pr_updated_at DESC;

-- #2a: Idempotent ALTER for existing databases — upgrade INTEGER token columns to
-- BIGINT so Codex long sessions (>2,147,483,647 tokens) do not overflow.
-- BIGINT->BIGINT is a no-op, so re-running on an already-upgraded DB is safe.
ALTER TABLE sessions ALTER COLUMN token_usage TYPE BIGINT;
ALTER TABLE sessions ALTER COLUMN token_in TYPE BIGINT;
ALTER TABLE sessions ALTER COLUMN token_out TYPE BIGINT;
ALTER TABLE transcript_events ALTER COLUMN token_usage TYPE BIGINT;
