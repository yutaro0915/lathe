#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LATHE_HOOK_VERSION } from './index.js';

interface InitOptions {
  cwd: string;
  serverUrl: string;
  projectId?: string;
  name?: string;
  notifyToken?: string;
}

type JsonRecord = Record<string, any>;

function usage(): string {
  return `lathe-client

Usage:
  lathe-client init [--server-url http://localhost:3000] [--notify-token <token>] [--project-id <id>] [--name <display-name>] [--cwd <path>]
`;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseInitOptions(): InitOptions {
  return {
    cwd: path.resolve(readArg('--cwd') || process.cwd()),
    serverUrl: readArg('--server-url') || process.env.LATHE_SERVER_URL || 'http://localhost:3000',
    projectId: readArg('--project-id'),
    name: readArg('--name'),
    notifyToken: readArg('--notify-token') || process.env.LATHE_NOTIFY_TOKEN,
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file: string): JsonRecord {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function execGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function normalizeGitRemote(remote: string): string {
  const value = remote.trim();
  const scp = /^git@([^:]+):(.+)$/.exec(value);
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, '').replace(/\/+/g, '/').toLowerCase();

  const ssh = /^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/.exec(value);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.replace(/\.git$/, '').replace(/\/+/g, '/').toLowerCase();

  const https = /^https?:\/\/([^/]+)\/(.+)$/.exec(value);
  if (https) return `${https[1]}/${https[2]}`.replace(/\.git$/, '').replace(/\/+/g, '/').toLowerCase();

  return value.replace(/\.git$/, '').replace(/\/+/g, '/').toLowerCase();
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function packageName(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name?: string };
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

function resolveProject(options: InitOptions): { projectId: string; displayName: string; gitRemote: string | null } {
  const latheDir = path.join(options.cwd, '.lathe');
  const projectIdPath = path.join(latheDir, 'project-id');
  const savedProjectId = fs.existsSync(projectIdPath) ? fs.readFileSync(projectIdPath, 'utf8').trim() : null;
  const remote = execGit(options.cwd, ['config', '--get', 'remote.origin.url']);
  const normalizedRemote = remote ? normalizeGitRemote(remote) : null;

  const projectId =
    options.projectId?.trim() ||
    savedProjectId ||
    normalizedRemote ||
    (options.name ? `manual/${slug(options.name)}` : null);

  if (!projectId) {
    throw new Error('No git remote found. Re-run with --project-id <id> or --name <display-name>.');
  }

  const displayName =
    options.name?.trim() ||
    packageName(options.cwd) ||
    (normalizedRemote ? normalizedRemote.split('/').slice(-2).join('/') : null) ||
    path.basename(options.cwd);

  return { projectId, displayName, gitRemote: normalizedRemote };
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function hookCommand(cwd: string, agent: 'claude-code' | 'codex'): string {
  return `${shellQuote(process.execPath)} ${shellQuote(path.join(cwd, '.lathe', 'hook.mjs'))} --agent ${agent} --event Stop`;
}

function mergeStopHook(settings: JsonRecord, command: string): JsonRecord {
  const next = { ...settings };
  const hooks = typeof next.hooks === 'object' && next.hooks !== null && !Array.isArray(next.hooks) ? { ...next.hooks } : {};
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  const hook = { type: 'command', command, timeout: 5 };
  let updated = false;

  for (const group of stop) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
    const existing = group.hooks.find((item: JsonRecord) => typeof item?.command === 'string' && item.command.includes('.lathe/hook.mjs') && item.command.includes('--agent claude-code'));
    if (existing) {
      existing.command = command;
      existing.timeout = 5;
      updated = true;
    }
  }

  if (!updated) stop.push({ hooks: [hook] });
  hooks.Stop = stop;
  next.hooks = hooks;
  return next;
}

function hookScript(): string {
  return `#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  try {
    const hookDir = path.dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(fs.readFileSync(path.join(hookDir, 'config.json'), 'utf8'));
    const raw = await readStdin();
    const hook = raw.trim() ? JSON.parse(raw) : {};
    const transcriptPath = typeof hook.transcript_path === 'string' ? hook.transcript_path : undefined;
    if (!transcriptPath) return;

    const payload = {
      agent: readArg('--agent') || 'claude-code',
      session_id: typeof hook.session_id === 'string' ? hook.session_id : undefined,
      transcript_path: transcriptPath,
      cwd: typeof hook.cwd === 'string' ? hook.cwd : process.cwd(),
      project_id: config.projectId,
      event: typeof hook.hook_event_name === 'string' ? hook.hook_event_name : readArg('--event') || 'Stop',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs || 1000));
    const headers = { 'content-type': 'application/json' };
    if (typeof config.notifyToken === 'string' && config.notifyToken.trim()) {
      headers.authorization = \`Bearer \${config.notifyToken.trim()}\`;
    }
    try {
      await fetch(new URL('/api/ingest/notify', config.serverUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (process.env.LATHE_HOOK_DEBUG === '1') {
      console.error('[lathe hook]', error && error.message ? error.message : String(error));
    }
  }
}

await main();
`;
}

function codexHooksJson(command: string): JsonRecord {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 5,
              statusMessage: 'Notifying Lathe',
            },
          ],
        },
      ],
    },
  };
}

function codexTomlSnippet(command: string): string {
  return `# Optional inline Codex hook snippet. Prefer .codex/hooks.json in this repo.
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = ${JSON.stringify(command)}
timeout = 5
statusMessage = "Notifying Lathe"
`;
}

function init(): void {
  const options = parseInitOptions();
  const project = resolveProject(options);
  const latheDir = path.join(options.cwd, '.lathe');
  const claudeSettingsPath = path.join(options.cwd, '.claude', 'settings.json');
  const codexHooksPath = path.join(options.cwd, '.codex', 'hooks.json');
  const codexTomlPath = path.join(latheDir, 'codex-hook.toml');
  const hookPath = path.join(latheDir, 'hook.mjs');
  const notifyToken = options.notifyToken?.trim() || crypto.randomBytes(32).toString('base64url');

  ensureDir(latheDir);
  fs.writeFileSync(path.join(latheDir, '.gitignore'), '*\n!.gitignore\n', 'utf8');
  fs.writeFileSync(path.join(latheDir, 'project-id'), `${project.projectId}\n`, 'utf8');
  writeJson(path.join(latheDir, 'config.json'), {
    serverUrl: options.serverUrl,
    projectId: project.projectId,
    displayName: project.displayName,
    gitRemote: project.gitRemote,
    cwd: options.cwd,
    notifyToken,
    hookVersion: LATHE_HOOK_VERSION,
    timeoutMs: 1000,
  });
  fs.writeFileSync(hookPath, hookScript(), { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);

  const claudeCommand = hookCommand(options.cwd, 'claude-code');
  writeJson(claudeSettingsPath, mergeStopHook(readJson(claudeSettingsPath), claudeCommand));

  const codexCommand = hookCommand(options.cwd, 'codex');
  writeJson(codexHooksPath, codexHooksJson(codexCommand));
  fs.writeFileSync(codexTomlPath, codexTomlSnippet(codexCommand), 'utf8');

  console.log(`lathe-client init ok`);
  console.log(`project_id=${project.projectId}`);
  console.log(`server_url=${options.serverUrl}`);
  console.log(`notify_token=${options.notifyToken?.trim() ? 'provided' : 'generated in .lathe/config.json'}`);
  console.log(`server_env=LATHE_NOTIFY_TOKEN=<same token>`);
  console.log(`claude_settings=${claudeSettingsPath}`);
  console.log(`codex_hooks=${codexHooksPath}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'init') {
    init();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
