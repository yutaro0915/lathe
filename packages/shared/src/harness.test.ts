import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  conventionalHarnessProvidersForPath,
  harnessVersionId,
  isMachineLocalHarnessPath,
  normalizeHarnessRelPath,
  snapshotFromHarnessEntries,
} from "./harness";

test("harnessVersionId is deterministic and scoped by project, provider, and content", () => {
  const id = harnessVersionId("project-a", "codex", "hash-a");

  assert.match(id, /^hv_[0-9a-f]{32}$/);
  assert.equal(harnessVersionId("project-a", "codex", "hash-a"), id);
  assert.notEqual(harnessVersionId("project-b", "codex", "hash-a"), id);
  assert.notEqual(harnessVersionId("project-a", "claude-code", "hash-a"), id);
  assert.notEqual(harnessVersionId("project-a", "codex", "hash-b"), id);
});

test("normalizes harness paths and maps conventional provider ownership", () => {
  assert.equal(normalizeHarnessRelPath("./nested/AGENTS.md"), "nested/AGENTS.md");
  assert.deepEqual(conventionalHarnessProvidersForPath("AGENTS.md"), ["claude-code", "codex"]);
  assert.deepEqual(conventionalHarnessProvidersForPath("docs/AGENTS.md"), ["claude-code", "codex"]);
  assert.deepEqual(conventionalHarnessProvidersForPath("CLAUDE.md"), ["claude-code"]);
  assert.deepEqual(conventionalHarnessProvidersForPath(".claude/settings.json"), ["claude-code"]);
  assert.deepEqual(conventionalHarnessProvidersForPath(".codex/config.toml"), ["codex"]);
  assert.deepEqual(conventionalHarnessProvidersForPath("skills/reviewer/SKILL.md"), ["claude-code", "codex"]);
  assert.deepEqual(conventionalHarnessProvidersForPath("README.md"), []);
});

test("identifies machine-local harness paths by basename", () => {
  assert.equal(isMachineLocalHarnessPath("AGENTS.local.md"), true);
  assert.equal(isMachineLocalHarnessPath("nested/CLAUDE.local.md"), true);
  assert.equal(isMachineLocalHarnessPath("nested/CLAUDE.md"), false);
});

test("snapshotFromHarnessEntries normalizes, filters, sorts, and hashes providers", () => {
  const snapshot = snapshotFromHarnessEntries(
    [
      { path: "z/AGENTS.md", providers: ["codex"], sha256: "b", bytes: 2 },
      { path: "./a/CLAUDE.md", providers: ["claude-code", "claude-code"], sha256: "a", bytes: 1 },
      { path: "ignored.local.md", providers: ["codex"], sha256: "local", bytes: 5 },
      { path: "ignored.md", providers: [], sha256: "none", bytes: 4 },
    ],
    "abc123",
  );

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.git_commit, "abc123");
  assert.deepEqual(
    snapshot.artifacts.map((artifact) => artifact.path),
    ["a/CLAUDE.md", "z/AGENTS.md"],
  );
  assert.deepEqual(snapshot.artifacts[0].providers, ["claude-code"]);
  assert.deepEqual(snapshot.artifacts[1].providers, ["codex"]);
  assert.match(snapshot.providers["claude-code"] ?? "", /^[0-9a-f]{64}$/);
  assert.match(snapshot.providers.codex ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(snapshot.providers["claude-code"], snapshot.providers.codex);
});
