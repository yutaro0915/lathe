import { spawnSync } from 'node:child_process';
import { buildChatAgentRequest, streamChatAgent, type ChatProviderName } from '../lib/chat-agent';
import { appendChatMessage, createChatThread } from '../lib/chat-store';
import { closePool, getPool } from '../lib/postgres';

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

async function firstSession(): Promise<{ id: string; title: string } | null> {
  const result = await getPool().query<{ id: string; title: string }>(
    `SELECT id,title
       FROM sessions
      ORDER BY seq ASC, started_at DESC, id ASC
      LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function main() {
  const provider = (process.env.LATHE_CHAT_SMOKE_PROVIDER || 'claude') as ChatProviderName;
  if (provider === 'claude' && !commandExists('claude')) {
    console.log('[smoke-chat-provider] SKIP: claude CLI is not available');
    return;
  }
  if (provider === 'codex' && !commandExists('codex')) {
    console.log('[smoke-chat-provider] SKIP: codex CLI is not available');
    return;
  }
  if (process.env.LATHE_RUN_REAL_PROVIDER_SMOKE !== '1') {
    console.log('[smoke-chat-provider] SKIP: set LATHE_RUN_REAL_PROVIDER_SMOKE=1 to run the manual real-provider smoke');
    return;
  }

  const session = await firstSession();
  if (!session) {
    console.log('[smoke-chat-provider] SKIP: no sessions in DB');
    return;
  }
  const thread = await createChatThread({
    title: `manual ${provider} chat smoke`,
    sessionId: session.id,
  });
  try {
    const user = await appendChatMessage({
      threadId: thread.id,
      role: 'user',
      body: `Use get_session_bundle for session ${session.id}, then answer in one short sentence.`,
      meta: { smoke: 'real-provider' },
    });
    const request = await buildChatAgentRequest({
      threadId: thread.id,
      provider,
      messages: [user],
      sessionId: session.id,
    });
    let text = '';
    let tools = 0;
    for await (const event of streamChatAgent(request)) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'tool_call') tools += 1;
    }
    if (!text.trim()) throw new Error(`${provider} returned no text`);
    if (tools < 1) throw new Error(`${provider} did not emit an observable Lathe MCP tool call`);
    console.log(`[smoke-chat-provider] GREEN provider=${provider} tools_observed=${tools} reply=${text.trim().slice(0, 160)}`);
  } finally {
    await getPool().query('DELETE FROM chat_threads WHERE id = $1', [thread.id]);
  }
}

main()
  .catch((error) => {
    console.error(`[smoke-chat-provider] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
