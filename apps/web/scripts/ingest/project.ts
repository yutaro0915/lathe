import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectIdentity {
  id: string;
  displayName: string;
  gitRemote: string | null;
  cwdHint: string | null;
}

const identityCache = new Map<string, ProjectIdentity>();
const INTERNAL_PROJECT_ID = 'lathe-internal';

function safePackageName(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

function getOriginRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function normalizeGitRemoteUrl(remote: string | null | undefined): string | null {
  const value = remote?.trim().replace(/^git\+/, '');
  if (!value) return null;

  let host = '';
  let repoPath = '';
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);

  if (scp && !value.includes('://')) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const url = new URL(value);
      host = url.hostname;
      repoPath = url.pathname;
    } catch {
      return null;
    }
  }

  const cleanPath = repoPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!host || !cleanPath) return null;
  return `${host.toLowerCase()}/${cleanPath}`;
}

function displayNameFromCanonical(canonical: string | null): string | null {
  if (!canonical) return null;
  const parts = canonical.split('/').filter(Boolean);
  if (parts.length >= 3) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts.at(-1) ?? null;
}

export function resolveProjectIdentity(cwd: string, fallbackName: string): ProjectIdentity {
  const normalizedCwd = cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : cwd;
  const cacheKey = normalizedCwd || `fallback:${fallbackName}`;
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;

  if (
    path.basename(normalizedCwd || fallbackName || '') === INTERNAL_PROJECT_ID ||
    fallbackName === INTERNAL_PROJECT_ID
  ) {
    const identity: ProjectIdentity = {
      id: INTERNAL_PROJECT_ID,
      displayName: INTERNAL_PROJECT_ID,
      gitRemote: null,
      cwdHint: normalizedCwd || null,
    };
    identityCache.set(cacheKey, identity);
    return identity;
  }

  const usableCwd = normalizedCwd && fs.existsSync(normalizedCwd) ? normalizedCwd : '';
  const gitRemote = usableCwd ? getOriginRemote(usableCwd) : null;
  const canonical = normalizeGitRemoteUrl(gitRemote);
  const displayName =
    (usableCwd ? safePackageName(usableCwd) : null) ??
    displayNameFromCanonical(canonical) ??
    fallbackName ??
    'project';

  const identity: ProjectIdentity = {
    id: canonical ?? `local:${usableCwd || fallbackName || 'project'}`,
    displayName,
    gitRemote,
    cwdHint: usableCwd || null,
  };
  identityCache.set(cacheKey, identity);
  return identity;
}
