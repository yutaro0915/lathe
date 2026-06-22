# ADR 0010: agent config home and shared ACP harness

- status: accepted
- date: 2026-06-23
- related: [0004](./0004-postgres-from-phase-1-and-hybrid-dev-env.md), [0009](./0009-agent-as-core-module.md)

## Context

Lathe drives existing agents through ACP as a local child process. Chat and analyst had separate ACP wiring, which duplicated adapter selection, MCP server construction, permission handling, and Claude settings behavior. Chat also avoided personal skill leakage by disabling all setting sources, which prevented lathe from shipping its own harness skills.

ADR 0004 keeps the app and worker on the host during development. ADR 0009 makes lathe an ACP client that launches a local subprocess and reuses the local credential instead of owning agent auth.

## Decision

The lathe agent runs as a host child process. Its runtime config home is `CLAUDE_CONFIG_DIR=~/.lathe`: mutable state and credentials stay in `$HOME` and out of git. The version-controlled source of the harness is `agent/`, containing the prompt, skills directory, and settings skeleton. `scripts/setup-lathe-agent.sh` populates `~/.lathe` with symlinks back to `agent/`.

ACP-driving wiring is consolidated in one shared module used by chat and analyst. That module injects `CLAUDE_CONFIG_DIR` and `settingSources:['user']`, so the user tier resolves to `~/.lathe` rather than a developer's personal `~/.claude`. It does not include the project tier, avoiding the repo's local `.claude/`.

Chat and analyst both use deny-by-default permission policies over the lathe MCP tools. Chat allows only read-only lathe tools. Analyst allows only `mcp__lathe__submit_finding` and its bare name.

This applies ADR 0004's host execution split and ADR 0009's ACP local subprocess / local credential model; it does not contradict either.

## Consequences

Lathe now has a clean, version-controlled harness source without storing auth. Future prompt, skill, and MCP curation should edit `agent/`, then rely on the setup script to expose it through `~/.lathe`.

Chat and analyst cannot silently diverge on ACP adapter defaults, config home, MCP env flags, or permission extraction. The shared permission parser includes `toolCall.title`, which claude-agent-acp uses for MCP tool names.

Switch to running the agent inside compose only if one of these triggers occurs:

- Phase 3 requires untrusted-code execution with OS-level sandboxing.
- A multi-user or hosted deployment needs per-user auth. That also requires the parked jsonl-push variant because filesystem-local transcript reads no longer hold.

Until then, the agent remains a host subprocess.
