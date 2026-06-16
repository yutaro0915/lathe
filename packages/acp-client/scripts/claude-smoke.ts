import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { latheMcpServer, runSession } from '../src/index.js';
import type { SessionUpdate } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const logDir = resolve(repoRoot, 'tmp');
const logPath = resolve(logDir, 'acp-client-claude-smoke.jsonl');
const databaseUrl = process.env.DATABASE_URL;

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasLatheToolEvidence(update: SessionUpdate): boolean {
  const text = JSON.stringify(update);
  return text.includes('mcp__lathe__list_sessions') || text.includes('fixture-acp-smoke-session');
}

async function log(event: string, data: unknown): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, data })}\n`);
}

async function main(): Promise<void> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for lathe MCP smoke');

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
          tools: ['mcp__lathe__list_sessions'],
        },
      },
    },
    timeoutMs: Number(process.env.ACP_SMOKE_TIMEOUT_MS ?? 180_000),
    prompt:
      'Use the MCP server named lathe. You must call its list_sessions tool exactly once, then report only the number of sessions returned and the first session id if any.',
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
  console.log(
    stringify({
      logPath,
      sessionId: result.sessionId,
      stopReason: result.prompt.stopReason,
      updateCount: updates.length,
      permissionCount: result.permissions.length,
      latheToolEvidenceCount: evidence.length,
      stderrTail: result.stderr.slice(-4000),
    }),
  );
  if (evidence.length === 0) {
    throw new Error('claude-agent-acp smoke completed without mcp__lathe__list_sessions or fixture result evidence in the update stream');
  }
}

main().catch((error) => {
  console.error(`[claude-smoke] ${(error as Error).message}`);
  process.exitCode = 1;
});
