import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export { HOOK_HARNESS_SOURCE } from "./hook-harness-source.js";

export type HarnessProvider = "claude-code" | "codex";

export interface HarnessArtifactSnapshot {
  path: string;
  providers: HarnessProvider[];
  sha256: string;
  bytes: number;
}

export interface HarnessSnapshot {
  version: 1;
  artifacts: HarnessArtifactSnapshot[];
  providers: Partial<Record<HarnessProvider, string>>;
  overhead_ms?: number;
  git_commit?: string | null;
}

export interface HarnessObservation {
  path: string;
  providers: HarnessProvider[];
}

const PROVIDERS: HarnessProvider[] = ["claude-code", "codex"];

export function harnessVersionId(projectId: string, provider: HarnessProvider, contentHash: string): string {
  return `hv_${crypto.createHash("sha256").update(`${projectId}\0${provider}\0${contentHash}`).digest("hex").slice(0, 32)}`;
}

export function normalizeHarnessRelPath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\/+/, "");
}

export function resolveHarnessGitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function conventionalHarnessProvidersForPath(relPath: string): HarnessProvider[] {
  const p = normalizeHarnessRelPath(relPath);
  if (p === "AGENTS.md" || p.endsWith("/AGENTS.md")) return ["claude-code", "codex"];
  if (p === "CLAUDE.md" || p.endsWith("/CLAUDE.md") || p.startsWith(".claude/")) return ["claude-code"];
  if (p.startsWith(".codex/")) return ["codex"];
  if (p.startsWith("skills/")) return ["claude-code", "codex"];
  return [];
}

export function isMachineLocalHarnessPath(relPath: string): boolean {
  return path.posix.basename(normalizeHarnessRelPath(relPath)).includes(".local.");
}

function mergeProviders(...groups: HarnessProvider[][]): HarnessProvider[] {
  const set = new Set<HarnessProvider>();
  for (const group of groups) for (const provider of group) set.add(provider);
  return PROVIDERS.filter((provider) => set.has(provider));
}

function observationMap(observations: HarnessObservation[] = []): Map<string, HarnessProvider[]> {
  const out = new Map<string, HarnessProvider[]>();
  for (const observation of observations) {
    const relPath = normalizeHarnessRelPath(observation.path);
    if (isMachineLocalHarnessPath(relPath)) continue;
    out.set(relPath, mergeProviders(out.get(relPath) ?? [], observation.providers));
  }
  return out;
}

function providersForPath(relPath: string, observations: Map<string, HarnessProvider[]>): HarnessProvider[] {
  const p = normalizeHarnessRelPath(relPath);
  if (isMachineLocalHarnessPath(p)) return [];
  return mergeProviders(observations.get(p) ?? [], conventionalHarnessProvidersForPath(p));
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function providerHash(artifacts: HarnessArtifactSnapshot[], provider: HarnessProvider): string {
  const hash = crypto.createHash("sha256");
  hash.update(`lathe-harness-v1\0${provider}\0`);
  for (const artifact of artifacts.filter((item) => item.providers.includes(provider))) {
    hash.update(artifact.path);
    hash.update("\0");
    hash.update(artifact.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function snapshotFromHarnessEntries(
  entries: HarnessArtifactSnapshot[],
  gitCommit?: string | null,
): HarnessSnapshot {
  const artifacts = entries
    .map((entry) => ({
      ...entry,
      path: normalizeHarnessRelPath(entry.path),
      providers: mergeProviders(entry.providers),
    }))
    .filter((entry) => entry.providers.length > 0 && !isMachineLocalHarnessPath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    artifacts,
    providers: {
      "claude-code": providerHash(artifacts, "claude-code"),
      codex: providerHash(artifacts, "codex"),
    },
    git_commit: gitCommit ?? null,
  };
}

function execGit(cwd: string, args: string[], encoding: "utf8"): string | null;
function execGit(cwd: string, args: string[], encoding: "buffer"): Buffer | null;
function execGit(cwd: string, args: string[], encoding: "utf8" | "buffer"): string | Buffer | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 20 * 1024 * 1024,
    }) as string | Buffer;
  } catch {
    return null;
  }
}

function currentGitCommit(cwd: string): string | null {
  return execGit(cwd, ["rev-parse", "--verify", "HEAD"], "utf8")?.trim() || null;
}

function normalizeGitCommit(cwd: string, commit: string): string | null {
  if (!/^[0-9a-f]{7,40}$/i.test(commit.trim())) return null;
  return execGit(cwd, ["rev-parse", "--verify", `${commit}^{commit}`], "utf8")?.trim() || null;
}

function gitTrackedFiles(cwd: string): string[] {
  const output = execGit(cwd, ["ls-files", "-z", "--cached"], "buffer");
  if (!output) return [];
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeHarnessRelPath);
}

function gitTreeFiles(cwd: string, commit: string): string[] {
  const output = execGit(cwd, ["ls-tree", "-rz", "--name-only", commit], "buffer");
  if (!output) return [];
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeHarnessRelPath);
}

function gitFileContent(cwd: string, commit: string, relPath: string): Buffer | null {
  return execGit(cwd, ["show", `${commit}:${relPath}`], "buffer");
}

export function captureLiveHarnessSnapshot(
  cwd: string,
  observations: HarnessObservation[] = [],
): HarnessSnapshot | null {
  const started = Date.now();
  const root = resolveHarnessGitRoot(cwd);
  if (!root) return null;
  const observed = observationMap(observations);
  const artifacts: HarnessArtifactSnapshot[] = [];
  for (const relPath of gitTrackedFiles(root).sort()) {
    const providers = providersForPath(relPath, observed);
    if (!providers.length) continue;
    const full = path.join(root, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(full);
    artifacts.push({
      path: relPath,
      providers,
      sha256: hashBuffer(content),
      bytes: content.byteLength,
    });
  }
  const snapshot = snapshotFromHarnessEntries(artifacts, currentGitCommit(root));
  snapshot.overhead_ms = Date.now() - started;
  return snapshot;
}

export function captureGitHarnessSnapshot(
  cwd: string,
  commitish: string,
  observations: HarnessObservation[] = [],
): HarnessSnapshot | null {
  const root = resolveHarnessGitRoot(cwd);
  if (!root) return null;
  const commit = normalizeGitCommit(root, commitish);
  if (!commit) return null;
  const observed = observationMap(observations);
  const artifacts: HarnessArtifactSnapshot[] = [];
  for (const relPath of gitTreeFiles(root, commit).sort()) {
    const providers = providersForPath(relPath, observed);
    if (!providers.length) continue;
    const content = gitFileContent(root, commit, relPath);
    if (!content) continue;
    artifacts.push({
      path: relPath,
      providers,
      sha256: hashBuffer(content),
      bytes: content.byteLength,
    });
  }
  return snapshotFromHarnessEntries(artifacts, commit);
}
