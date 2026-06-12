import { spawnSync } from 'node:child_process';
import {
  buildAgentLaunchConfig,
  buildChatAgentRequest,
  streamChatAgent,
  type ChatAgentEvent,
} from '../lib/chat-agent';
import {
  ALLOWED_AGENT_TOOL_NAMES,
  DISALLOWED_AGENT_TOOL_NAMES,
  LATHE_MCP_TOOL_NAMES,
  assertAllowedAgentTool,
  invokeLatheMcpTool,
} from '../lib/chat-tools';
import {
  appendChatMessage,
  createChatThread,
  MAX_CHAT_MESSAGE_BODY_CHARS,
  MAX_CHAT_THREADS,
} from '../lib/chat-store';
import { closePool, getPool } from '../lib/postgres';
import { resolveProjectIdentity } from './ingest/project';

type SessionRow = { id: string; title: string };

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label} mismatch: actual=${a} expected=${e}`);
}

function assertContains<T>(values: readonly T[], expected: T, label: string): void {
  if (!values.includes(expected)) fail(`${label} missing ${String(expected)}`);
}

function argValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) fail(`missing ${flag}`);
  return args[index + 1];
}

async function firstSession(): Promise<SessionRow> {
  const result = await getPool().query<SessionRow>(
    `SELECT id,title
       FROM sessions
      ORDER BY seq ASC, started_at DESC, id ASC
      LIMIT 1`,
  );
  return result.rows[0] ?? fail('no sessions found; run pnpm -F web ingest first');
}

async function collect(request: Awaited<ReturnType<typeof buildChatAgentRequest>>) {
  let text = '';
  const events: ChatAgentEvent[] = [];
  for await (const event of streamChatAgent(request)) {
    events.push(event);
    if (event.type === 'text') text += event.text;
  }
  return { text, events };
}

async function verifyToolRestriction(): Promise<void> {
  assertEqual(
    [...LATHE_MCP_TOOL_NAMES],
    ['list_sessions', 'get_session_bundle', 'query_findings', 'get_evidence_context', 'submit_finding'],
    'lathe MCP tool names',
  );
  assertEqual(
    [...ALLOWED_AGENT_TOOL_NAMES],
    [
      'mcp__lathe__list_sessions',
      'mcp__lathe__get_session_bundle',
      'mcp__lathe__query_findings',
      'mcp__lathe__get_evidence_context',
      'mcp__lathe__submit_finding',
    ],
    'agent allowed tools',
  );
  for (const provider of ['claude', 'codex'] as const) {
    const config = buildAgentLaunchConfig(provider);
    assertEqual([...config.allowedTools], [...ALLOWED_AGENT_TOOL_NAMES], `${provider} allowed tools`);
    assertEqual(config.promptTransport, 'stdin', `${provider} prompt transport`);
    if (config.args.some((arg) => arg.includes('ASSISTANT:') || arg.includes('Conversation:'))) {
      fail(`${provider} launch args contain prompt text`);
    }
    for (const required of [
      'Bash',
      'Edit',
      'Write',
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'Task',
      'NotebookEdit',
      'TodoWrite',
    ]) {
      assertContains(config.disallowedTools, required, `${provider} disallowed tools`);
    }
    assertEqual(Object.keys(config.mcpServers), ['lathe'], `${provider} MCP server`);
    const server = config.mcpServers.lathe;
    assertEqual(server.args, ['--dir', config.repoRoot, '-F', '@lathe/mcp', 'stdio'], `${provider} MCP server command args`);
    assertEqual(server.env?.LATHE_INTERNAL_AGENT, 'chat', `${provider} MCP internal agent env`);
    assertEqual(server.env?.LATHE_CHAT_PROVIDER, provider, `${provider} MCP provider env`);
    for (const forbidden of DISALLOWED_AGENT_TOOL_NAMES) {
      if (config.allowedTools.includes(forbidden as never)) fail(`${provider} allowed tools expose forbidden tool ${forbidden}`);
    }
    if (provider === 'claude') {
      assertContains(config.args, '--strict-mcp-config', 'claude args');
      assertEqual(argValue(config.args, '--tools'), '', 'claude built-in tools disabled');
      assertEqual(argValue(config.args, '--allowedTools'), ALLOWED_AGENT_TOOL_NAMES.join(','), 'claude allowed tools flag');
      const disallowed = argValue(config.args, '--disallowedTools').split(',');
      for (const required of config.disallowedTools) assertContains(disallowed, required, 'claude disallowed flag');
      const allowedIndex = config.args.indexOf('--allowedTools');
      if (allowedIndex !== config.args.length - 2) fail('claude --allowedTools must be terminal so no prompt is parsed as a tool');
    } else {
      assertContains(config.args, '--ignore-user-config', 'codex args');
      assertContains(config.args, '--ignore-rules', 'codex args');
      assertEqual(argValue(config.args, '--sandbox'), 'read-only', 'codex sandbox');
      assertEqual(argValue(config.args, '--ask-for-approval'), 'never', 'codex approval policy');
      assertEqual(argValue(config.args, '--cd'), config.internalCwd, 'codex internal cwd');
    }
  }
  for (const forbidden of DISALLOWED_AGENT_TOOL_NAMES) {
    let rejected = false;
    try {
      assertAllowedAgentTool(forbidden);
    } catch {
      rejected = true;
    }
    if (!rejected) fail(`forbidden tool was accepted: ${forbidden}`);
  }
  console.log('[verify-chat:3-tool-restriction-static] GREEN');
}

async function verifyRuntimeForbiddenFixture(): Promise<void> {
  const thread = await createChatThread({ title: 'verify chat forbidden fixture' });
  try {
    const user = await appendChatMessage({
      threadId: thread.id,
      role: 'user',
      body: 'forbidden tool fixture',
      meta: { verify: 'chat-forbidden' },
    });
    const request = await buildChatAgentRequest({
      threadId: thread.id,
      provider: 'fake',
      messages: [user],
    });
    let rejected = false;
    try {
      await collect(request);
    } catch (error) {
      rejected = (error as Error).message.includes('tool denied');
    }
    if (!rejected) fail('fake provider forbidden tool fixture was not rejected');
  } finally {
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
  console.log('[verify-chat:3-tool-restriction-runtime] GREEN');
}

async function verifyMcpSessionBundleFixture(): Promise<void> {
  const session = await firstSession();
  const thread = await createChatThread({
    title: 'verify chat get_session_bundle fixture',
    sessionId: session.id,
  });
  try {
    const user = await appendChatMessage({
      threadId: thread.id,
      role: 'user',
      body: 'Use the attached session bundle.',
      meta: { verify: 'chat-bundle' },
    });
    const request = await buildChatAgentRequest({
      threadId: thread.id,
      provider: 'fake',
      messages: [user],
      sessionId: session.id,
    });
    const result = await collect(request);
    if (!result.events.some((event) => event.type === 'tool_call' && event.name === 'get_session_bundle')) {
      fail('fake provider did not call get_session_bundle');
    }
    if (!result.text.includes(session.title)) {
      fail(`fake provider response did not use session bundle title: ${result.text}`);
    }
  } finally {
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
  console.log('[verify-chat:4-mcp-session-bundle] GREEN');
}

async function verifySubmitFindingFixture(): Promise<void> {
  const session = await firstSession();
  const thread = await createChatThread({
    title: 'verify chat submit_finding fixture',
    sessionId: session.id,
  });
  const title = `Chat submitted finding ${thread.id.slice(-8)}`;
  try {
    const user = await appendChatMessage({
      threadId: thread.id,
      role: 'user',
      body: 'submit finding',
      meta: { verify: 'chat-submit-finding' },
    });
    const request = await buildChatAgentRequest({
      threadId: thread.id,
      provider: 'fake',
      messages: [user],
      sessionId: session.id,
    });
    const result = await collect(request);
    if (!result.events.some((event) => event.type === 'tool_call' && event.name === 'submit_finding')) {
      fail('fake provider did not call submit_finding');
    }
    const row = (
      await getPool().query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM findings
          WHERE analyst = 'chat:fake'
            AND title = $1`,
        [title],
      )
    ).rows[0];
    if (row?.n !== 1) fail(`submit_finding did not insert exactly one finding for ${title}`);
  } finally {
    await getPool().query(
      `DELETE FROM findings
        WHERE analyst = 'chat:fake'
          AND title = $1`,
      [title],
    );
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
  console.log('[verify-chat:6-submit-finding] GREEN');
}

async function verifySubmitFindingEnvStamp(): Promise<void> {
  const session = await firstSession();
  const title = `Chat env-stamped finding ${process.pid}`;
  const previousAgent = process.env.LATHE_INTERNAL_AGENT;
  const previousProvider = process.env.LATHE_CHAT_PROVIDER;
  process.env.LATHE_INTERNAL_AGENT = 'chat';
  process.env.LATHE_CHAT_PROVIDER = 'verify';
  try {
    await invokeLatheMcpTool('submit_finding', {
      finding: {
        analyst: 'model-supplied-analyst',
        kind: 'risky_action',
        title,
        body: 'Verifier ensures chat MCP submit_finding stamps the server-side analyst.',
        confidence: 0.51,
        evidence: [
          {
            subject_kind: 'session',
            session_id: session.id,
            subject_id: session.id,
            locator: { session_id: session.id },
            note: 'verify chat analyst env stamp',
          },
        ],
      },
    });
    const row = (
      await getPool().query<{ analyst: string }>('SELECT analyst FROM findings WHERE title = $1', [title])
    ).rows[0];
    assertEqual(row?.analyst, 'chat:verify', 'chat finding env analyst stamp');
  } finally {
    if (previousAgent === undefined) delete process.env.LATHE_INTERNAL_AGENT;
    else process.env.LATHE_INTERNAL_AGENT = previousAgent;
    if (previousProvider === undefined) delete process.env.LATHE_CHAT_PROVIDER;
    else process.env.LATHE_CHAT_PROVIDER = previousProvider;
    await getPool().query('DELETE FROM findings WHERE title = $1', [title]);
  }
  console.log('[verify-chat:6-submit-finding-env-stamp] GREEN');
}

async function verifyInternalProjectTagging(): Promise<void> {
  const identity = resolveProjectIdentity('/tmp/lathe-internal', 'lathe-internal');
  assertEqual(identity.id, 'lathe-internal', 'internal project id');
  assertEqual(identity.displayName, 'lathe-internal', 'internal project display name');
  console.log('[verify-chat:7-self-observation-tag] GREEN');
}

async function verifySizeLimits(): Promise<void> {
  if (MAX_CHAT_THREADS <= 0) fail('MAX_CHAT_THREADS must be positive');
  const thread = await createChatThread({ title: 'verify chat size fixture' });
  try {
    let rejected = false;
    try {
      await appendChatMessage({
        threadId: thread.id,
        role: 'user',
        body: 'x'.repeat(MAX_CHAT_MESSAGE_BODY_CHARS + 1),
      });
    } catch (error) {
      rejected = (error as Error).message.includes('chat message body');
    }
    if (!rejected) fail('oversized chat message was not rejected');
  } finally {
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
  console.log('[verify-chat:8-size-limits] GREEN');
}

async function verifyPersistenceDelegation(): Promise<void> {
  const run = spawnSync('pnpm', ['-F', 'web', 'verify:phase2:persistence'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (run.status !== 0) fail(`verify:phase2:persistence failed\n${run.stdout}\n${run.stderr}`);
  console.log('[verify-chat:7-persistence] GREEN');
}

async function run(command: string | undefined): Promise<void> {
  if (!command || command === 'all') {
    await verifyToolRestriction();
    await verifyRuntimeForbiddenFixture();
    await verifyMcpSessionBundleFixture();
    await verifySubmitFindingFixture();
    await verifySubmitFindingEnvStamp();
    await verifyInternalProjectTagging();
    await verifySizeLimits();
    await verifyPersistenceDelegation();
    return;
  }
  if (command === 'tools') return verifyToolRestriction();
  if (command === 'forbidden') return verifyRuntimeForbiddenFixture();
  if (command === 'bundle') return verifyMcpSessionBundleFixture();
  if (command === 'submit') return verifySubmitFindingFixture();
  if (command === 'stamp') return verifySubmitFindingEnvStamp();
  if (command === 'internal') return verifyInternalProjectTagging();
  if (command === 'limits') return verifySizeLimits();
  if (command === 'persistence') return verifyPersistenceDelegation();
  fail('usage: tsx scripts/verify-chat.ts all|tools|forbidden|bundle|submit|stamp|internal|limits|persistence');
}

run(process.argv[2])
  .catch((error) => {
    console.error(`[verify-chat] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
