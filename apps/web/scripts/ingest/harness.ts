import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import type { Runner } from '../../lib/types';
import type { Built } from './built';

export type HarnessProvider = 'claude-code' | 'codex';

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

export interface HarnessBackfillReport {
  reconstructed: number;
  unreconstructable: number;
}

const PROVIDERS: HarnessProvider[] = ['claude-code', 'codex'];

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function harnessVersionId(projectId: string, provider: HarnessProvider, contentHash: string): string {
  return `hv_${crypto.createHash('sha256').update(`${projectId}\0${provider}\0${contentHash}`).digest('hex').slice(0, 32)}`;
}

function normalizeRelPath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\/+/, '');
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function providersForPath(relPath: string): HarnessProvider[] {
  const p = normalizeRelPath(relPath);
  if (p === 'AGENTS.md') return ['claude-code', 'codex'];
  if (p === 'CLAUDE.md' || p.startsWith('.claude/')) return ['claude-code'];
  if (p.startsWith('.codex/')) return ['codex'];
  if (p.startsWith('skills/')) return ['claude-code', 'codex'];
  if (p.endsWith('/AGENTS.md')) return ['claude-code', 'codex'];
  if (p.endsWith('/CLAUDE.md')) return ['claude-code'];
  return [];
}

function addFilePathsFromDir(cwd: string, relDir: string, out: Set<string>): void {
  const fullDir = path.join(cwd, relDir);
  if (!fs.existsSync(fullDir)) return;
  const stack = [fullDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.add(normalizeRelPath(path.relative(cwd, full)));
      }
    }
  }
}

function staticCandidatePaths(cwd: string): Set<string> {
  const out = new Set<string>([
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.codex/config.toml',
    '.codex/hooks.json',
  ]);
  addFilePathsFromDir(cwd, '.claude/commands', out);
  addFilePathsFromDir(cwd, '.claude/agents', out);
  addFilePathsFromDir(cwd, '.claude/hooks', out);
  addFilePathsFromDir(cwd, '.codex', out);
  addFilePathsFromDir(cwd, 'skills', out);
  return out;
}

function observedHarnessPaths(cwd: string, built?: Built): Set<string> {
  const out = new Set<string>();
  if (!built) return out;
  for (const event of built.events) {
    if (event.type !== 'memory' && event.type !== 'hook' && event.type !== 'skill') continue;
    const candidates = [event.file_path, event.command].filter((value): value is string => !!value);
    for (const candidate of candidates) {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
      if (isWithin(cwd, absolute)) out.add(normalizeRelPath(path.relative(cwd, absolute)));
    }
  }
  return out;
}

function providerHash(artifacts: HarnessArtifactSnapshot[], provider: HarnessProvider): string {
  const hash = crypto.createHash('sha256');
  hash.update(`lathe-harness-v1\0${provider}\0`);
  for (const artifact of artifacts.filter((item) => item.providers.includes(provider))) {
    hash.update(artifact.path);
    hash.update('\0');
    hash.update(artifact.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function snapshotFromEntries(entries: HarnessArtifactSnapshot[], gitCommit?: string | null): HarnessSnapshot {
  const artifacts = entries
    .map((entry) => ({
      ...entry,
      path: normalizeRelPath(entry.path),
      providers: [...entry.providers].sort() as HarnessProvider[],
    }))
    .filter((entry) => entry.providers.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    artifacts,
    providers: {
      'claude-code': providerHash(artifacts, 'claude-code'),
      codex: providerHash(artifacts, 'codex'),
    },
    git_commit: gitCommit ?? null,
  };
}

export function captureHarnessSnapshot(cwd: string, built?: Built): HarnessSnapshot | null {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) return null;

  const paths = staticCandidatePaths(root);
  for (const observed of observedHarnessPaths(root, built)) paths.add(observed);

  const artifacts: HarnessArtifactSnapshot[] = [];
  for (const relPath of [...paths].sort()) {
    const providers = providersForPath(relPath);
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
      path: normalizeRelPath(relPath),
      providers,
      sha256: hashBuffer(content),
      bytes: content.byteLength,
    });
  }

  return snapshotFromEntries(artifacts, currentGitCommit(root));
}

function execGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function currentGitCommit(cwd: string): string | null {
  return execGit(cwd, ['rev-parse', '--verify', 'HEAD']);
}

function normalizeGitRef(cwd: string, ref: string): string | null {
  return execGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

function gitFileList(cwd: string, ref: string): string[] {
  const output = execGit(cwd, ['ls-tree', '-r', '--name-only', ref]);
  return output ? output.split('\n').filter(Boolean).map(normalizeRelPath) : [];
}

function gitFileContent(cwd: string, ref: string, relPath: string): Buffer | null {
  try {
    return execFileSync('git', ['-C', cwd, 'show', `${ref}:${relPath}`], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function captureHarnessSnapshotFromGit(cwd: string, ref: string): HarnessSnapshot | null {
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) return null;
  const commit = normalizeGitRef(root, ref);
  if (!commit) return null;

  const artifacts: HarnessArtifactSnapshot[] = [];
  for (const relPath of gitFileList(root, commit)) {
    const providers = providersForPath(relPath);
    if (!providers.length) continue;
    const content = gitFileContent(root, commit, relPath);
    if (!content) continue;
    artifacts.push({
      path: normalizeRelPath(relPath),
      providers,
      sha256: hashBuffer(content),
      bytes: content.byteLength,
    });
  }

  return snapshotFromEntries(artifacts, commit);
}

export function isHarnessProvider(value: Runner): value is HarnessProvider {
  return value === 'claude-code' || value === 'codex';
}

export function sessionHarnessRef(built: Built): string | null {
  const commit = built.sessionCommits.at(-1)?.sha;
  if (commit) return commit;
  return built.session.git_branch?.trim() || null;
}

export function backfillHarnessSnapshot(built: Built): HarnessSnapshot | null {
  const cwd = built.session.projectCwdHint;
  const ref = sessionHarnessRef(built);
  if (!cwd || !ref) return null;
  return captureHarnessSnapshotFromGit(cwd, ref);
}

export async function upsertHarnessSnapshot(
  client: PoolClient,
  projectId: string,
  provider: HarnessProvider,
  snapshot: HarnessSnapshot,
): Promise<string> {
  for (const artifact of snapshot.artifacts) {
    await client.query(
      `INSERT INTO harness_artifacts (project_id,path,providers,updated_at)
       VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
       ON CONFLICT (project_id, path) DO UPDATE SET
         providers = EXCLUDED.providers,
         updated_at = CURRENT_TIMESTAMP`,
      [projectId, artifact.path, artifact.providers],
    );
  }

  const contentHash = snapshot.providers[provider];
  if (!contentHash) throw new Error(`harness snapshot is missing provider hash for ${provider}`);
  const id = harnessVersionId(projectId, provider, contentHash);
  await client.query(
    `INSERT INTO harness_versions (id,project_id,provider,content_hash,captured_at,git_commit)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$5)
     ON CONFLICT (project_id, provider, content_hash) DO UPDATE SET
       git_commit = COALESCE(harness_versions.git_commit, EXCLUDED.git_commit)
     RETURNING id`,
    [id, projectId, provider, contentHash, snapshot.git_commit ?? null],
  );
  return id;
}

export async function backfillHarnessVersions(client: PoolClient, built: Built[]): Promise<HarnessBackfillReport> {
  let reconstructed = 0;
  let unreconstructable = 0;
  for (const item of built) {
    if (!isHarnessProvider(item.session.runner)) {
      unreconstructable++;
      continue;
    }
    const snapshot = backfillHarnessSnapshot(item);
    if (!snapshot) {
      item.session.harness_version_id = null;
      unreconstructable++;
      continue;
    }
    item.session.harness_version_id = await upsertHarnessSnapshot(
      client,
      item.session.projectId,
      item.session.runner,
      snapshot,
    );
    reconstructed++;
  }
  return { reconstructed, unreconstructable };
}
