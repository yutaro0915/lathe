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
} from '../lib/chat-tools';
import { appendChatMessage, createChatThread } from '../lib/chat-store';
import { closePool, getPool } from '../lib/postgres';

type SessionRow = { id: string; title: string };

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label} mismatch: actual=${a} expected=${e}`);
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
    assertEqual(config.disallowedTools, [], `${provider} disallowed launch tools`);
    assertEqual(Object.keys(config.mcpServers), ['lathe'], `${provider} MCP server`);
    const server = config.mcpServers.lathe;
    assertEqual(server.args, ['-F', '@lathe/mcp', 'stdio'], `${provider} MCP server command args`);
    for (const forbidden of DISALLOWED_AGENT_TOOL_NAMES) {
      if (config.args.includes(forbidden)) fail(`${provider} launch args expose forbidden tool ${forbidden}`);
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
          WHERE analyst = 'chat-fake-provider'
            AND title = $1`,
        [title],
      )
    ).rows[0];
    if (row?.n !== 1) fail(`submit_finding did not insert exactly one finding for ${title}`);
  } finally {
    await getPool().query(
      `DELETE FROM findings
        WHERE analyst = 'chat-fake-provider'
          AND title = $1`,
      [title],
    );
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
  console.log('[verify-chat:6-submit-finding] GREEN');
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
    await verifyPersistenceDelegation();
    return;
  }
  if (command === 'tools') return verifyToolRestriction();
  if (command === 'forbidden') return verifyRuntimeForbiddenFixture();
  if (command === 'bundle') return verifyMcpSessionBundleFixture();
  if (command === 'submit') return verifySubmitFindingFixture();
  if (command === 'persistence') return verifyPersistenceDelegation();
  fail('usage: tsx scripts/verify-chat.ts all|tools|forbidden|bundle|submit|persistence');
}

run(process.argv[2])
  .catch((error) => {
    console.error(`[verify-chat] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
