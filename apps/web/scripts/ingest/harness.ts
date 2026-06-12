import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import {
  captureGitHarnessSnapshot,
  captureLiveHarnessSnapshot,
  harnessVersionId,
  normalizeHarnessRelPath,
  resolveHarnessGitRoot,
  type HarnessObservation,
  type HarnessProvider,
  type HarnessSnapshot,
} from '@lathe/shared/harness';
import type { Runner } from '../../lib/types';
import type { Built } from './built';

export type {
  HarnessArtifactSnapshot,
  HarnessObservation,
  HarnessProvider,
  HarnessSnapshot,
} from '@lathe/shared/harness';
export { harnessVersionId } from '@lathe/shared/harness';

export interface HarnessBackfillReport {
  reconstructed: number;
  unreconstructable: number;
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isHarnessProvider(value: Runner): value is HarnessProvider {
  return value === 'claude-code' || value === 'codex';
}

function observationsFromBuilt(cwd: string, built?: Built): HarnessObservation[] {
  if (!built || !isHarnessProvider(built.session.runner)) return [];
  const resolvedRoot = resolveHarnessGitRoot(cwd);
  const root = resolvedRoot ? fs.realpathSync(resolvedRoot) : null;
  if (!root) return [];
  const out: HarnessObservation[] = [];
  for (const event of built.events) {
    if (event.type !== 'memory' && event.type !== 'hook' && event.type !== 'skill') continue;
    const candidates = [event.file_path, event.command].filter((value): value is string => !!value);
    for (const candidate of candidates) {
      const rawAbsolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
      let absolute = rawAbsolute;
      try {
        absolute = fs.realpathSync(rawAbsolute);
      } catch {
        // Commands can be recorded in the same field as paths; non-path values are ignored below.
      }
      if (!isWithin(root, absolute)) continue;
      out.push({
        path: normalizeHarnessRelPath(path.relative(root, absolute)),
        providers: [built.session.runner],
      });
    }
  }
  return out;
}

export function captureHarnessSnapshot(cwd: string, built?: Built): HarnessSnapshot | null {
  return captureLiveHarnessSnapshot(cwd, observationsFromBuilt(cwd, built));
}

export function captureHarnessSnapshotFromGit(cwd: string, commit: string, built?: Built): HarnessSnapshot | null {
  return captureGitHarnessSnapshot(cwd, commit, observationsFromBuilt(cwd, built));
}

export function sessionHarnessRef(built: Built): string | null {
  return built.sessionCommits.at(-1)?.sha ?? null;
}

export function backfillHarnessSnapshot(built: Built): HarnessSnapshot | null {
  const cwd = built.session.projectCwdHint;
  const ref = sessionHarnessRef(built);
  if (!cwd || !ref) return null;
  return captureHarnessSnapshotFromGit(cwd, ref, built);
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
