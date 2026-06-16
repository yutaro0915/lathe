import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { latheMcpServer, runSession } from '../src/index.js';
import type { SessionUpdate } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const logDir = resolve(repoRoot, 'tmp');
const logPath = process.env.ACP_SMOKE_LOG_PATH ? resolve(process.env.ACP_SMOKE_LOG_PATH) : resolve(logDir, 'acp-client-claude-smoke.jsonl');
const databaseUrl = process.env.DATABASE_URL;

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasLatheToolEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return (
    text.includes('mcp__lathe__list_sessions') ||
    text.includes('"toolName":"mcp__lathe__list_sessions"') ||
    text.includes('fixture-acp-smoke-session')
  );
}

function hasLatheServerConnectedEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"name":"lathe"') && text.includes('"status":"connected"');
}

function hasSubscriptionAuthEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('"apiKeySource":"none"') || text.includes('"rateLimitType"');
}

async function log(event: string, data: unknown): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, data })}\n`);
}

async function main(): Promise<void> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for lathe MCP smoke');
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, '');

  const updates: SessionUpdate[] = [];
  const result = await runSession({
    adapter: {
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    },
    cwd: repoRoot,
    mcpServers: [latheMcpServer({ repoRoot, databaseUrl })],
    sessionMeta: {
      claudeCode: {
        emitRawSDKMessages: true,
        options: {
          tools: ['mcp__lathe__list_sessions', 'Bash'],
        },
      },
    },
    timeoutMs: Number(process.env.ACP_SMOKE_TIMEOUT_MS ?? 180_000),
    prompt:
      'Use the MCP server named lathe. First call its list_sessions tool exactly once. Then run the Bash command `printf acp-permission-smoke` exactly once. Report only the number of sessions returned, the first session id if any, and the Bash output.',
    onUpdate: async (update) => {
      updates.push(update);
      await log('update', update);
    },
    onPermission: async (request) => {
      await log('permission_request', request);
      const allow =
        request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always') ?? request.options[0];
      const outcome = allow ? { outcome: 'selected' as const, optionId: allow.optionId } : { outcome: 'cancelled' as const };
      await log('permission_response', outcome);
      return outcome;
    },
  });

  await log('result', result);
  const evidence = updates.filter(hasLatheToolEvidence);
  const connected = updates.some(hasLatheServerConnectedEvidence);
  const subscriptionAuth = updates.some(hasSubscriptionAuthEvidence);
  console.log(
    stringify({
      logPath,
      sessionId: result.sessionId,
      stopReason: result.prompt.stopReason,
      updateCount: updates.length,
      permissionCount: result.permissions.length,
      latheToolEvidenceCount: evidence.length,
      latheServerConnected: connected,
      subscriptionAuthEvidence: subscriptionAuth,
      stderrTail: result.stderr.slice(-4000),
    }),
  );
  if (updates.length === 0) {
    throw new Error('claude-agent-acp smoke completed without session/update stream evidence');
  }
  if (!connected) {
    throw new Error('claude-agent-acp smoke completed without lathe MCP server connected evidence');
  }
  if (evidence.length === 0) {
    throw new Error('claude-agent-acp smoke completed without mcp__lathe__list_sessions or fixture result evidence in the update stream');
  }
  if (result.permissions.length === 0) {
    throw new Error('claude-agent-acp smoke completed without session/request_permission round-trip evidence');
  }
  if (!subscriptionAuth) {
    throw new Error('claude-agent-acp smoke completed without subscription auth evidence such as apiKeySource=none or rate_limit_event');
  }
}

main().catch((error) => {
  console.error(`[claude-smoke] ${(error as Error).message}`);
  process.exitCode = 1;
});
