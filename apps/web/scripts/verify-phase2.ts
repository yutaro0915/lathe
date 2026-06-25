import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { closePool, getPool } from '../lib/postgres';
import type { Built } from './ingest/built';
import { insertBuilt } from './ingest/repository/ingest-writer';
import {
  captureHarnessSnapshot,
  captureHarnessSnapshotFromGit,
  type HarnessProvider,
} from './ingest/harness';
import { ingestNotify, type IngestNotifyPayload } from './ingest/notify';
import { buildClaudeSession } from './ingest/providers/claude';
import { pickDefaultTranscriptsDir } from './ingest/shared';
import { withScratchDatabase } from './verify/scratch';

const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');
const VERIFY_BUILD_OPTIONS = { maxEvents: 100000, maxFiles: 100000, maxHunkLines: 200 };

function fail(message: string): never {
  throw new Error(message);
}

function findRepoRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function claudeTranscriptDirs(): string[] {
  if (process.env.LATHE_TRANSCRIPTS_DIR) return [process.env.LATHE_TRANSCRIPTS_DIR];

  const dirs: string[] = [];
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(base, entry.name));
    }
  } catch {
    // Fall back to the ingester's default below.
  }

  dirs.push(pickDefaultTranscriptsDir());
  return [...new Set(dirs)];
}

async function runChild(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function applySchema(): Promise<void> {
  await getPool().query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await getPool().query(sql, params);
  return result.rows[0] ? (Object.values(result.rows[0])[0] as T) : fail(`no result for ${sql}`);
}

function firstStableClaudeTranscript(): string {
  const dirs = claudeTranscriptDirs();
  const files = dirs
    .flatMap((dir) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => {
            const full = path.join(dir, file);
            return { full, mtimeMs: fs.statSync(full).mtimeMs };
          });
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) fail(`no Claude transcripts found in ${dirs.join(', ')}`);
  const cutoff = Date.now() - 180_000;
  const stable = files.filter((file) => file.mtimeMs < cutoff);
  const candidates = stable.length ? [...stable, ...files.filter((file) => file.mtimeMs >= cutoff)] : files;
  const ingestable = candidates.find((file) => {
    try {
      return (buildClaudeSession(file.full, VERIFY_BUILD_OPTIONS)?.events.length ?? 0) > 0;
    } catch {
      return false;
    }
  });
  if (!ingestable) fail(`no ingestable Claude transcripts found in ${dirs.join(', ')}`);
  return ingestable.full;
}

function minimalBuiltSession(id: string, projectId: string, cwd: string | null, sha: string | null): Built {
  return {
    session: {
      id,
      projectId,
      project: projectId,
      projectGitRemote: null,
      projectCwdHint: cwd,
      title: id,
      runner: 'codex',
      model: 'codex-test',
      status: 'done',
      started_at: '2026-06-11 00:00:00',
      ended_at: '2026-06-11 00:00:01',
      duration_ms: 1000,
      turn_count: 1,
      tool_count: 0,
      edit_count: 0,
      bash_count: 0,
      subagent_count: 0,
      error_count: 0,
      token_usage: 0,
      token_in: 0,
      token_out: 0,
      git_branch: null,
      commit_count: sha ? 1 : 0,
      cost_usd: null,
      summary: null,
      harness_version_id: null,
      parent_session_id: null,
      spawned_by_seq: null,
      seq: 0,
      _startMs: Date.now(),
    },
    events: [
      {
        id: `${id}_1`,
        session_id: id,
        seq: 1,
        ts: '00:00:00',
        type: 'user_message',
        actor: 'user',
        title: 'verify backfill',
        body: 'verify backfill',
        file_path: null,
        command: null,
        exit_code: null,
        duration_ms: null,
        token_usage: null,
        subagent: null,
        meta: null,
        parent_id: null,
      },
    ],
    sessionCommits: sha ? [{ session_id: id, sha, event_id: null, source: 'verify' }] : [],
    commitShaMissCount: 0,
    eventFiles: [],
    changedFiles: [],
    hunks: [],
    attributions: [],
    annotations: [],
  };
}

function independentSha256(value: string): string {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function independentProviderHash(
  artifacts: Array<{ path: string; providers: HarnessProvider[]; sha256: string }>,
  provider: HarnessProvider,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(`lathe-harness-v1\0${provider}\0`);
  for (const artifact of artifacts
    .filter((item) => item.providers.includes(provider))
    .sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(artifact.path);
    hash.update('\0');
    hash.update(artifact.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function verifyHook(): Promise<void> {
  const root = findRepoRoot();
  const build = spawnSync('pnpm', ['-F', 'client', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) fail(`client build failed before hook verify\n${build.stdout}\n${build.stderr}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-hook-phase2-'));
  ensureDir(path.join(tmp, '.claude'));
  ensureDir(path.join(tmp, 'nested'));
  ensureDir(path.join(tmp, '.codex'));
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared harness\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'nested', 'AGENTS.md'), 'nested shared harness\n', 'utf8');
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{"hooks":{}}\n', 'utf8');
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.local.json'), '{"machine":"local"}\n', 'utf8');
  fs.writeFileSync(path.join(tmp, '.codex', 'untracked-config.toml'), 'model = "untracked"\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'transcript.jsonl'), '{}\n', 'utf8');
  execGit(tmp, ['init']);
  execGit(tmp, ['config', 'user.email', 'lathe@example.test']);
  execGit(tmp, ['config', 'user.name', 'Lathe Verify']);
  execGit(tmp, ['add', 'AGENTS.md', 'nested/AGENTS.md', '.claude/settings.json']);
  execGit(tmp, ['add', '-f', '.claude/settings.local.json']);
  execGit(tmp, ['commit', '-m', 'tracked harness']);

  const received: unknown[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') fail('hook verify server did not expose a port');
  try {
    const cli = path.join(root, 'packages', 'client', 'dist', 'cli.js');
    const init = spawnSync(
      process.execPath,
      [cli, 'init', '--cwd', tmp, '--server-url', `http://127.0.0.1:${address.port}`, '--project-id', 'phase2-hook'],
      { cwd: root, encoding: 'utf8' },
    );
    if (init.status !== 0) fail(`lathe-client init failed\n${init.stdout}\n${init.stderr}`);

    const hook = path.join(tmp, '.lathe', 'hook.mjs');
    const stdin = JSON.stringify({
      session_id: 'phase2-hook-session',
      transcript_path: path.join(tmp, 'transcript.jsonl'),
      cwd: tmp,
      hook_event_name: 'Stop',
    });
    const run = await runChild(process.execPath, [hook, '--agent', 'claude-code', '--event', 'Stop'], {
      cwd: tmp,
      input: stdin,
      env: { ...process.env, LATHE_HOOK_DEBUG: '1' },
    });
    if (run.status !== 0) fail(`hook exited non-zero\n${run.stdout}\n${run.stderr}`);
    if (received.length !== 1) {
      fail(`expected one hook payload, got ${received.length}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    }
    const payload = received[0] as Record<string, any>;
    if (!payload.harness_hash) fail('payload missing harness_hash');
    if (payload.harness_hash.overhead_ms >= 50) {
      fail(`harness hash overhead too high: ${payload.harness_hash.overhead_ms}ms`);
    }
    if (!payload.harness_hash.providers?.['claude-code'] || !payload.harness_hash.providers?.codex) {
      fail('payload harness_hash missing provider hashes');
    }
    const artifacts = payload.harness_hash.artifacts as Array<{ path: string; providers: string[] }>;
    const rootAgents = artifacts.find((item) => item.path === 'AGENTS.md');
    const nestedAgents = artifacts.find((item) => item.path === 'nested/AGENTS.md');
    const settings = artifacts.find((item) => item.path === '.claude/settings.json');
    if (!rootAgents?.providers.includes('claude-code') || !rootAgents.providers.includes('codex')) {
      fail('hook payload AGENTS.md binding is not shared');
    }
    if (!nestedAgents?.providers.includes('claude-code') || !nestedAgents.providers.includes('codex')) {
      fail('hook payload nested AGENTS.md binding is not shared');
    }
    if (!settings?.providers.includes('claude-code') || settings.providers.includes('codex')) {
      fail('hook payload .claude/settings.json binding is not claude-only');
    }
    if (artifacts.some((item) => item.path.includes('.local.') || item.path.includes('untracked'))) {
      fail('hook payload included local or untracked harness artifact');
    }

    const configPath = path.join(tmp, '.lathe', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.notifyToken;
    config.serverUrl = 'http://127.0.0.1:9';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const failOpen = await runChild(process.execPath, [hook, '--agent', 'claude-code', '--event', 'Stop'], {
      cwd: tmp,
      input: stdin,
      env: { ...process.env, LATHE_HOOK_DEBUG: '1' },
    });
    if (failOpen.status !== 0) fail(`hook did not fail-open without token/server\n${failOpen.stderr}`);
    console.log(`[verify-phase2:hook] ok overhead_ms=${payload.harness_hash.overhead_ms}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function verifyNotifyStamp(): Promise<void> {
  await applySchema();
  const root = findRepoRoot();
  const transcript = firstStableClaudeTranscript();
  process.env.LATHE_NOTIFY_ALLOWED_ROOTS = path.dirname(transcript);
  const snapshot = captureHarnessSnapshot(root) ?? fail('could not capture harness snapshot');
  const payload: IngestNotifyPayload = {
    agent: 'claude-code',
    transcript_path: transcript,
    cwd: root,
    project_id: 'phase2-notify-project',
    event: 'Stop',
    harness_hash: snapshot,
  };
  const first = await ingestNotify(payload);
  const firstVersion = await scalar<string>('SELECT harness_version_id FROM sessions WHERE id = $1', [first.sessionId]);
  if (!firstVersion) fail('session missing harness_version_id after first notify');
  const second = await ingestNotify(payload);
  const secondVersion = await scalar<string>('SELECT harness_version_id FROM sessions WHERE id = $1', [second.sessionId]);
  if (firstVersion !== secondVersion) fail(`notify was not idempotent: ${firstVersion} != ${secondVersion}`);
  const sweep = spawnSync('pnpm', ['-F', 'web', 'ingest'], {
    cwd: root,
    env: { ...process.env, LATHE_TRANSCRIPTS_DIR: path.dirname(transcript) },
    encoding: 'utf8',
  });
  if (sweep.status !== 0) fail(`notify preservation sweep failed\n${sweep.stdout}\n${sweep.stderr}`);
  const sweepVersion = await scalar<string>('SELECT harness_version_id FROM sessions WHERE id = $1', [first.sessionId]);
  if (sweepVersion !== firstVersion) fail(`sweep overwrote notify stamp: ${sweepVersion} != ${firstVersion}`);
  console.log(`[verify-phase2:notify] ok session=${first.sessionId} harness_version_id=${secondVersion} sweep_preserved=true`);
}

async function verifyBindings(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-harness-bindings-'));
  try {
    ensureDir(path.join(tmp, '.claude'));
    ensureDir(path.join(tmp, 'nested'));
    ensureDir(path.join(tmp, '.codex'));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared v1\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'nested', 'AGENTS.md'), 'nested shared v1\n', 'utf8');
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{"env":{"A":"1"}}\n', 'utf8');
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.local.json'), '{"env":{"LOCAL":"1"}}\n', 'utf8');
    fs.writeFileSync(path.join(tmp, '.codex', 'untracked.toml'), 'model = "untracked"\n', 'utf8');
    execGit(tmp, ['init']);
    execGit(tmp, ['config', 'user.email', 'lathe@example.test']);
    execGit(tmp, ['config', 'user.name', 'Lathe Verify']);
    execGit(tmp, ['add', 'AGENTS.md', 'nested/AGENTS.md', '.claude/settings.json']);
    execGit(tmp, ['add', '-f', '.claude/settings.local.json']);
    execGit(tmp, ['commit', '-m', 'tracked harness v1']);
    const commit = execGit(tmp, ['rev-parse', 'HEAD']);
    const base = captureHarnessSnapshot(tmp) ?? fail('base snapshot missing');
    const fromGit = captureHarnessSnapshotFromGit(tmp, commit) ?? fail('git snapshot missing');
    if (base.providers['claude-code'] !== fromGit.providers['claude-code'] || base.providers.codex !== fromGit.providers.codex) {
      fail('live and git harness hashes diverged for the same repo state');
    }
    if (!base.artifacts.some((item) => item.path === 'nested/AGENTS.md')) fail('nested AGENTS.md missing from harness artifacts');
    if (base.artifacts.some((item) => item.path.includes('.local.') || item.path.includes('untracked'))) {
      fail('local or untracked artifact was included in harness snapshot');
    }
    const observed = minimalBuiltSession('phase2-bindings-observed', 'phase2-bindings-project', tmp, commit);
    observed.session.runner = 'codex';
    observed.events = [
      {
        ...observed.events[0],
        type: 'skill',
        file_path: path.join(tmp, '.claude', 'settings.json'),
      },
    ];
    const observedSnapshot = captureHarnessSnapshot(tmp, observed) ?? fail('observed binding snapshot missing');
    const observedSettings = observedSnapshot.artifacts.find((item) => item.path === '.claude/settings.json');
    if (!observedSettings?.providers.includes('codex')) fail('observed provider binding did not supplement filename convention');

    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared v2\n', 'utf8');
    const sharedChanged = captureHarnessSnapshot(tmp) ?? fail('shared snapshot missing');
    if (base.providers['claude-code'] === sharedChanged.providers['claude-code']) {
      fail('AGENTS.md change did not change claude hash');
    }
    if (base.providers.codex === sharedChanged.providers.codex) fail('AGENTS.md change did not change codex hash');

    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared v1\n', 'utf8');
    const beforeSettings = captureHarnessSnapshot(tmp) ?? fail('settings base snapshot missing');
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{"env":{"A":"2"}}\n', 'utf8');
    const settingsChanged = captureHarnessSnapshot(tmp) ?? fail('settings changed snapshot missing');
    if (beforeSettings.providers['claude-code'] === settingsChanged.providers['claude-code']) {
      fail('.claude/settings.json change did not change claude hash');
    }
    if (beforeSettings.providers.codex !== settingsChanged.providers.codex) {
      fail('.claude/settings.json change changed codex hash');
    }
    console.log('[verify-phase2:bindings] ok shared/provider-specific hashes and live/git canonicality match ADR 0005');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function verifyBackfill(): Promise<void> {
  await applySchema();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-backfill-repo-'));
  try {
    execGit(tmp, ['init']);
    execGit(tmp, ['config', 'user.email', 'lathe@example.test']);
    execGit(tmp, ['config', 'user.name', 'Lathe Verify']);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared v1\n', 'utf8');
    ensureDir(path.join(tmp, '.codex'));
    fs.writeFileSync(path.join(tmp, '.codex', 'config.toml'), 'model = "codex"\n', 'utf8');
    execGit(tmp, ['add', 'AGENTS.md', '.codex/config.toml']);
    execGit(tmp, ['commit', '-m', 'harness v1']);
    const firstCommit = execGit(tmp, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'shared v2\n', 'utf8');
    execGit(tmp, ['add', 'AGENTS.md']);
    execGit(tmp, ['commit', '-m', 'harness v2']);

    const expectedContentHash = independentProviderHash(
      [
        { path: '.codex/config.toml', providers: ['codex'], sha256: independentSha256('model = "codex"\n') },
        { path: 'AGENTS.md', providers: ['claude-code', 'codex'], sha256: independentSha256('shared v1\n') },
      ],
      'codex',
    );
    const db = getPool();
    const reconstructable = minimalBuiltSession('phase2-backfill-ok', 'phase2-backfill-project', tmp, firstCommit);
    const missing = minimalBuiltSession('phase2-backfill-missing', 'phase2-backfill-project', null, null);
    const branchOnly = minimalBuiltSession('phase2-backfill-branch-only', 'phase2-backfill-project', tmp, null);
    branchOnly.session.git_branch = 'main';
    await insertBuilt(db, [branchOnly, reconstructable, missing]);
    const rows = await db.query<{ id: string; harness_version_id: string | null; content_hash: string | null }>(
      `SELECT s.id,s.harness_version_id,hv.content_hash
         FROM sessions s
         LEFT JOIN harness_versions hv ON hv.id = s.harness_version_id
        WHERE s.id LIKE 'phase2-backfill-%'
        ORDER BY s.id`,
    );
    const ok = rows.rows.find((row) => row.id === 'phase2-backfill-ok');
    const bad = rows.rows.find((row) => row.id === 'phase2-backfill-missing');
    const branch = rows.rows.find((row) => row.id === 'phase2-backfill-branch-only');
    if (!ok?.harness_version_id || ok.content_hash !== expectedContentHash) {
      fail(`reconstructed session got wrong harness content hash: ${ok?.content_hash} expected ${expectedContentHash}`);
    }
    if (bad?.harness_version_id !== null) fail('unreconstructable session was stamped');
    if (branch?.harness_version_id !== null) fail('branch-only session was stamped');

    const root = findRepoRoot();
    const ingest = spawnSync('pnpm', ['-F', 'web', 'ingest'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    if (ingest.status !== 0) fail(`real backfill ingest failed\n${ingest.stdout}\n${ingest.stderr}`);
    const realStamped = await scalar<number>(
      `SELECT COUNT(*)::int
         FROM sessions
        WHERE harness_version_id IS NOT NULL`,
    );
    if (realStamped <= 0) fail('real transcript sweep did not stamp any harness versions');
    console.log(`[verify-phase2:backfill] ok reconstructed=1 unreconstructable=2 real_stamped=${realStamped}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function verifyFindings(): Promise<void> {
  await applySchema();
  const projectId = `phase2-findings-${process.pid}`;
  await getPool().query(
    `INSERT INTO projects (id,display_name) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [projectId, projectId],
  );
  const inserted = await getPool().query<{ id: number }>(
    `INSERT INTO findings (analyst,kind,title,body,confidence,project_id)
     VALUES ('rules-v1','failure_loop','Loop detected','Repeated failed command',0.8,$1)
     RETURNING id`,
    [projectId],
  );
  const findingId = inserted.rows[0]?.id ?? fail('finding insert returned no id');
  await getPool().query(
    `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
     VALUES ($1,'turn','session-1',$2,'turn:1','first turn')`,
    [findingId, { seq: 1 }],
  );
  await getPool().query(
    `INSERT INTO finding_verdicts (finding_id,verdict,reason)
     VALUES ($1,'accept','actionable')`,
    [findingId],
  );
  const joined = await getPool().query<{ evidence_count: number; verdict_count: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM finding_evidence WHERE finding_id = $1) AS evidence_count,
       (SELECT COUNT(*)::int FROM finding_verdicts WHERE finding_id = $1) AS verdict_count`,
    [findingId],
  );
  if (joined.rows[0]?.evidence_count !== 1 || joined.rows[0]?.verdict_count !== 1) {
    fail('finding evidence/verdict query returned wrong counts');
  }

  let rejected = false;
  try {
    await getPool().query(
      `INSERT INTO findings (analyst,kind,title,body,confidence,project_id)
       VALUES ('rules-v1','not_a_kind','Bad','Bad',0.5,$1)`,
      [projectId],
    );
  } catch {
    rejected = true;
  }
  if (!rejected) fail('findings.kind CHECK did not reject invalid kind');
  console.log(`[verify-phase2:findings] ok finding_id=${findingId}`);
}

async function verifyPersistence(): Promise<void> {
  await applySchema();
  const marker = `phase2-persist-${process.pid}`;
  let findingId: number | null = null;
  try {
    await getPool().query(
      `INSERT INTO projects (id,display_name) VALUES ($1,$1)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [marker],
    );
    const finding = await getPool().query<{ id: number }>(
      `INSERT INTO findings (analyst,kind,title,body,confidence,project_id)
       VALUES ('rules-v1','risky_action',$1,'persistent body',0.6,$2)
       RETURNING id`,
      [`${marker} finding`, marker],
    );
    findingId = finding.rows[0]?.id ?? fail('persistence finding insert failed');
    await getPool().query(
      `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,note)
       VALUES ($1,'session',$2,$3,'persistent evidence')`,
      [findingId, marker, { session_id: marker }],
    );
    await getPool().query(
      `INSERT INTO finding_verdicts (finding_id,verdict,reason)
       VALUES ($1,'reject','persistent verdict')`,
      [findingId],
    );
    await getPool().query(
      `INSERT INTO chat_threads (id,project_id,title,session_id,finding_id)
       VALUES ($1,$2,'Persistent thread',$3,$4)`,
      [`${marker}-thread`, marker, marker, findingId],
    );
    await getPool().query(
      `INSERT INTO chat_messages (id,thread_id,role,body,seq)
       VALUES ($1,$2,'user','Persistent message',1)`,
      [`${marker}-message`, `${marker}-thread`],
    );
    await getPool().query(
      `INSERT INTO sessions (id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,seq)
       VALUES ($1,$2,$2,'Derived annotation marker','codex','codex-test','done','2026-06-11 00:00:00','2026-06-11 00:00:01',1000,-999)`,
      [marker, marker],
    );
    await getPool().query(
      `INSERT INTO annotations (session_id,at_seq,kind,note)
       VALUES ($1,7,'note','persistent annotation')`,
      [marker],
    );

    const before = await getPool().query(
      `SELECT
         (SELECT COUNT(*)::int FROM findings WHERE id = $1) AS findings,
         (SELECT COUNT(*)::int FROM finding_verdicts WHERE finding_id = $1) AS verdicts,
         (SELECT COUNT(*)::int FROM finding_evidence WHERE finding_id = $1) AS evidence,
         (SELECT COUNT(*)::int FROM chat_threads WHERE id = $2) AS threads,
         (SELECT COUNT(*)::int FROM chat_messages WHERE thread_id = $2) AS messages,
         (SELECT COUNT(*)::int FROM annotations WHERE session_id = $3) AS annotations`,
      [findingId, `${marker}-thread`, marker],
    );

    const root = findRepoRoot();
    const ingest = spawnSync('pnpm', ['-F', 'web', 'ingest'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    if (ingest.status !== 0) fail(`pnpm -F web ingest failed\n${ingest.stdout}\n${ingest.stderr}`);

    const after = await getPool().query(
      `SELECT
         (SELECT COUNT(*)::int FROM findings WHERE id = $1) AS findings,
         (SELECT COUNT(*)::int FROM finding_verdicts WHERE finding_id = $1) AS verdicts,
         (SELECT COUNT(*)::int FROM finding_evidence WHERE finding_id = $1) AS evidence,
         (SELECT COUNT(*)::int FROM chat_threads WHERE id = $2) AS threads,
         (SELECT COUNT(*)::int FROM chat_messages WHERE thread_id = $2) AS messages,
         (SELECT COUNT(*)::int FROM annotations WHERE session_id = $3) AS annotations,
         (SELECT COUNT(*)::int FROM sessions) AS sessions,
         (SELECT COUNT(*)::int FROM transcript_events) AS events`,
      [findingId, `${marker}-thread`, marker],
    );

    const beforeRow = before.rows[0];
    const afterRow = after.rows[0];
    for (const key of ['findings', 'verdicts', 'evidence', 'threads', 'messages']) {
      if (beforeRow[key] !== afterRow[key]) fail(`persistent ${key} changed across ingest`);
    }
    if (beforeRow.annotations !== 1 || afterRow.annotations !== 0) {
      fail('derived annotations did not get rebuilt from scratch');
    }
    if (afterRow.sessions < 1 || afterRow.events < 1) fail('derived session/event rows were not rebuilt');
    console.log(`[verify-phase2:persistence] ok sessions=${afterRow.sessions} events=${afterRow.events}`);
  } finally {
    if (findingId != null) {
      await getPool().query('DELETE FROM findings WHERE id = $1', [findingId]);
    }
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [`${marker}-thread`]);
    await getPool().query('DELETE FROM annotations WHERE session_id = $1', [marker]);
    await getPool().query('DELETE FROM sessions WHERE id = $1', [marker]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [marker]);
  }
}

async function resolveEvidence(evidenceId: number): Promise<{ seq: number; title: string; type: string } | null> {
  const result = await getPool().query<{ seq: number; title: string; type: string }>(
    `SELECT e.seq,e.title,e.type
       FROM finding_evidence fe
       JOIN transcript_events e
         ON e.session_id = fe.session_id
        AND e.seq = (fe.locator->>'seq')::int
        AND (fe.locator->>'type' IS NULL OR e.type = fe.locator->>'type')
        AND (fe.locator->>'title' IS NULL OR e.title = fe.locator->>'title')
      WHERE fe.id = $1`,
    [evidenceId],
  );
  return result.rows[0] ?? null;
}

async function verifyEvidence(): Promise<void> {
  await applySchema();
  const root = findRepoRoot();
  const transcript = firstStableClaudeTranscript();
  process.env.LATHE_NOTIFY_ALLOWED_ROOTS = path.dirname(transcript);
  const payload: IngestNotifyPayload = {
    agent: 'claude-code',
    transcript_path: transcript,
    cwd: root,
    project_id: 'phase2-evidence-project',
    event: 'Stop',
    harness_hash: captureHarnessSnapshot(root) ?? undefined,
  };
  const first = await ingestNotify(payload);
  const event = await getPool().query<{ seq: number; title: string; type: string }>(
    `SELECT seq,title,type
      FROM transcript_events
      WHERE session_id = $1
        AND type IN ('user_message','assistant_message')
      ORDER BY seq ASC, id ASC
      LIMIT 1`,
    [first.sessionId],
  );
  const target = event.rows[0] ?? fail(`no turn-like event found for ${first.sessionId}`);
  const finding = await getPool().query<{ id: number }>(
    `INSERT INTO findings (analyst,kind,title,body,confidence,project_id)
     VALUES ('rules-v1','failure_loop','Evidence verify','Evidence verify',0.9,$1)
     RETURNING id`,
    ['phase2-evidence-project'],
  );
  const evidence = await getPool().query<{ id: number }>(
    `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,note)
     VALUES ($1,'turn',$2,$3,'logical turn coordinate')
     RETURNING id`,
    [finding.rows[0]?.id, first.sessionId, { seq: target.seq, type: target.type, title: target.title }],
  );
  const evidenceId = evidence.rows[0]?.id ?? fail('evidence insert failed');
  const before = (await resolveEvidence(evidenceId)) ?? fail('evidence did not resolve before notify replace');
  await ingestNotify(payload);
  const after = (await resolveEvidence(evidenceId)) ?? fail('evidence did not resolve after notify replace');
  if (before.seq !== after.seq || before.title !== after.title || before.type !== after.type) {
    fail(`evidence resolved to different event after replace: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  console.log(`[verify-phase2:evidence] ok session=${first.sessionId} seq=${after.seq}`);
}

async function runVerifyCommand(command: string | undefined): Promise<void> {
  if (command === 'hook') return verifyHook();
  if (command === 'notify') return verifyNotifyStamp();
  if (command === 'bindings') return verifyBindings();
  if (command === 'backfill') return verifyBackfill();
  if (command === 'findings') return verifyFindings();
  if (command === 'persistence') return verifyPersistence();
  if (command === 'evidence') return verifyEvidence();
  if (command === 'all') {
    await verifyHook();
    await verifyNotifyStamp();
    await verifyBindings();
    await verifyBackfill();
    await verifyFindings();
    await verifyPersistence();
    await verifyEvidence();
    return;
  }
  fail('usage: tsx scripts/verify-phase2.ts hook|notify|bindings|backfill|findings|persistence|evidence|all');
}

async function main(): Promise<void> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  await withScratchDatabase('phase2_verify', () => runVerifyCommand(process.argv[2]));
  if (previousDatabaseUrl === undefined) {
    if (process.env.DATABASE_URL !== undefined) fail('DATABASE_URL was not restored after scratch teardown');
  } else if (process.env.DATABASE_URL !== previousDatabaseUrl) {
    fail('DATABASE_URL changed after scratch teardown');
  }
}

main()
  .catch((error) => {
    console.error(`[verify-phase2] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
