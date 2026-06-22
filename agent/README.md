# Lathe Agent Harness

This directory is the version-controlled source of truth for the lathe agent harness: prompt, skills, and settings.

Runtime configuration lives in `~/.lathe`, outside this repository. Run `pnpm setup:agent` from the repository root to populate `~/.lathe` with symlinks to:

- `agent/CLAUDE.md`
- `agent/skills`
- `agent/settings.json`

The ACP adapter uses `CLAUDE_CONFIG_DIR=~/.lathe` so the user settings tier resolves to lathe's harness instead of a developer's personal Claude config.

Authentication is not stored here. The agent uses the existing `CLAUDE_CODE_OAUTH_TOKEN` environment variable inherited by the adapter process.
