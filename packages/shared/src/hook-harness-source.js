export const HOOK_HARNESS_SOURCE = String.raw`
function normalizeHarnessRelPath(value) {
  return value.split(path.sep).join('/').replace(/^\.\/+/, '');
}

function resolveHarnessGitRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function conventionalHarnessProvidersForPath(relPath) {
  const p = normalizeHarnessRelPath(relPath);
  if (p === 'AGENTS.md' || p.endsWith('/AGENTS.md')) return ['claude-code', 'codex'];
  if (p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md') || p.startsWith('.claude/')) return ['claude-code'];
  if (p.startsWith('.codex/')) return ['codex'];
  if (p.startsWith('skills/')) return ['claude-code', 'codex'];
  return [];
}

function isMachineLocalHarnessPath(relPath) {
  return path.posix.basename(normalizeHarnessRelPath(relPath)).includes('.local.');
}

function mergeProviders(...groups) {
  const set = new Set();
  for (const group of groups) for (const provider of group) set.add(provider);
  return ['claude-code', 'codex'].filter((provider) => set.has(provider));
}

function providersForPath(relPath) {
  const p = normalizeHarnessRelPath(relPath);
  if (isMachineLocalHarnessPath(p)) return [];
  return mergeProviders(conventionalHarnessProvidersForPath(p));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function providerHash(artifacts, provider) {
  const hash = crypto.createHash('sha256');
  hash.update('lathe-harness-v1\0' + provider + '\0');
  for (const artifact of artifacts.filter((item) => item.providers.includes(provider))) {
    hash.update(artifact.path);
    hash.update('\0');
    hash.update(artifact.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function execGitBuffer(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function execGitText(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
    }).trim() || null;
  } catch {
    return null;
  }
}

function gitTrackedFiles(cwd) {
  const output = execGitBuffer(cwd, ['ls-files', '-z', '--cached']);
  if (!output) return [];
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizeHarnessRelPath);
}

function captureLiveHarnessSnapshot(cwd) {
  const started = Date.now();
  const root = resolveHarnessGitRoot(cwd || process.cwd());
  if (!root) return undefined;
  const artifacts = [];
  for (const relPath of gitTrackedFiles(root).sort()) {
    const providers = providersForPath(relPath);
    if (!providers.length) continue;
    const full = path.join(root, relPath);
    let stat;
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
      sha256: sha256(content),
      bytes: content.byteLength,
    });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    artifacts,
    providers: {
      'claude-code': providerHash(artifacts, 'claude-code'),
      codex: providerHash(artifacts, 'codex'),
    },
    git_commit: execGitText(root, ['rev-parse', '--verify', 'HEAD']),
    overhead_ms: Date.now() - started,
  };
}
`;
