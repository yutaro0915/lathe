# Lathe

**Observe, analyze and cost your coding-agent sessions.** A local viewer over your
*real* Claude Code and Codex runs — transcript timeline, Git-diff attribution,
per-session & per-project stats, token **cost**, sub-agent and **harness**
(memory / hook) visibility.

> This is **Phase 1 (observation)** of a larger harness-engineering platform — see [Roadmap](#roadmap).

## Requirements

- **Node ≥ 24**
- **Docker Compose** for the development Postgres dependency
- Your own transcripts on this machine: Claude Code (`~/.claude/projects/**`)
  and/or Codex (`~/.codex/sessions/**`)

## Quickstart

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d --wait
pnpm -F web ingest     # catch-up sweep: read existing transcripts into Postgres
export LATHE_NOTIFY_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
pnpm -F web dev        # http://localhost:3000
```

Then initialize each repo you want Lathe to observe:

```bash
pnpm -F @lathe/client build
# in the observed repo, after installing @lathe/client:
lathe-client init --server-url http://localhost:3000
# finish a Claude Code or Codex turn in that repo; the Stop hook notifies Lathe
```

By default `ingest` picks your **most-recently-active Claude project** and the
Codex sessions whose `cwd` matches it. Override via env:

- `LATHE_TRANSCRIPTS_DIR=~/.claude/projects/<dir>` — a specific Claude project
- `LATHE_CODEX_PROJECT=<repo-basename>` — which Codex sessions to include (by cwd)
- `LATHE_NO_CODEX=1` — skip Codex entirely
- `LATHE_NOTIFY_TOKEN=<secret>` — shared secret required by
  `POST /api/ingest/notify`; `lathe-client init` reads it from the environment

> The ingested database is regenerable. Re-run `pnpm ingest` after new sessions;
> restart the app if you are relying on the catch-up sweep. Once `lathe-client init`
> is installed, Stop hooks POST only the session pointer to `/api/ingest/notify`;
> Lathe reads that transcript server-side and replaces that one session
> idempotently. Override the connection with `DATABASE_URL`; the local default is
> shown in [.env.example](./.env.example).

## What you get (Phase 1)

- **Transcript** — the full run timeline (messages, tools, file edits, thinking),
  a time ribbon (hover = exact time/step, click = jump), per-event detail.
- **Sub-agents** — each distinct run as its own tab: model, cost, tool calls, and
  the full internal execution; an overview spine of "who did what".
- **Git diff & attribution** — reconstructed changed-files tree (compact folders)
  with each hunk linked back to the event that produced it.
- **Stats** (`/stats`) — per-**project** (directory) and per-**file** rollups
  (sessions / duration / tokens / cost / ± / errors, drill into the sessions),
  plus a usage panel: models, sub-agent types, skills, **memory loads**, **hooks**.
- **Cost** — derived from real token usage × bundled model pricing
  (Claude + GPT/Codex, cache-aware; `db/pricing.json`, sourced from LiteLLM, MIT).
- **Harness signals** — which nested `CLAUDE.md` / `AGENTS.md` were loaded and
  which hooks fired (PreToolUse / PostToolUse / Stop).
- **Push ingest** — `lathe-client init` installs fail-open Stop hooks. Hooks send
  `{agent, session_id, transcript_path, cwd, project_id, event}` only with
  `Authorization: Bearer <LATHE_NOTIFY_TOKEN>`; the server reads allowlisted
  transcript files and ingests that session incrementally.

Both **Claude Code** and **Codex** runs land in the same viewer/stats, tagged by runner.

## Honest limitations

- The **root** `CLAUDE.md` / `AGENTS.md` isn't persisted to the Claude JSONL, so
  only **nested** memory loads are observable.
- **Codex** raw reasoning is encrypted — only the visible reasoning *summary* is
  shown; Codex has no read tool, so file reads are detected from shell `cat`/`sed`.
- **Cursor** isn't supported yet (different format).

## Publishing

This package is `private: true` while it stabilizes. To publish: pick an
available npm name, remove `"private"`, optionally add a `bin`/CLI for `npx`,
then `npm publish`.

## License

MIT © Yutaro Ono — see [LICENSE](./LICENSE). Bundled pricing in `db/pricing.json`
mirrors [BerriAI/litellm](https://github.com/BerriAI/litellm) (MIT).

---

## Roadmap

A platform to **observe, analyze, improve and evaluate** existing coding agents
(Claude Code / Codex / Cursor / Devin …) rather than build one. Built in stages:

1. **Transcript display & analysis** (Web UI + DB) — *this release*.
2. **Harness improvement** — propose & apply changes to instruction files
   (CLAUDE.md / AGENTS.md / .cursorrules), hooks, skills, MCP servers, settings,
   prompt patterns. Levels: 1 config layer → 2 custom harness (Agents SDK / OSS)
   → 3 workflow (multi-step control, branching, parallel, state). Data model
   anticipates level 3; implementation starts at level 1.
3. **Controlled-experiment substrate** — Docker / git-isolated, reproducible runs.
4. **Evals / LLM-as-judge** — rubric-defined evaluation on top of (3).
5. **Agent connection** — integrate existing agent services (no agent built here);
   observe via git / chat, operate each provider via plugins.
6. **Integration** — one loop: observe(1) → analyze(1) → improve(2) →
   experiment(3) → evaluate(4) → apply(5).
