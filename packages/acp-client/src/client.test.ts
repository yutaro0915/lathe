import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, latheMcpServer, runSession } from './index';
import { hasLatheListSessionsCallEvidence } from './smoke-evidence';
import type { AdapterCommand, McpServer, PermissionRequest, SessionUpdate } from './index';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const fakeAgent = resolve(packageRoot, 'test/fixtures/fake-acp-agent.mjs');

function fakeAdapter(env: Record<string, string> = {}): AdapterCommand {
  return {
    command: process.execPath,
    args: [fakeAgent],
    env,
  };
}

test('runSession drives initialize/new/prompt/update lifecycle with fake ACP agent', async () => {
  const updates: SessionUpdate[] = [];
  const mcpServers: McpServer[] = [latheMcpServer({ repoRoot, databaseUrl: 'postgres://lathe:lathe@localhost:55433/lathe' })];

  const result = await runSession({
    adapter: fakeAdapter(),
    cwd: repoRoot,
    mcpServers,
    prompt: 'Use the lathe MCP server and summarize list_sessions.',
    onUpdate: (update) => {
      updates.push(update);
    },
    onPermission: (request) => ({ outcome: 'selected', optionId: 'allow-once' }),
  });

  assert.equal(result.initialize.protocolVersion, 1);
  assert.equal(result.sessionId, 'fake-session-1');
  assert.equal(result.prompt.stopReason, 'end_turn');
  assert.equal(result.permissions.length, 1);
  assert.equal(result.permissions[0].outcome.outcome, 'selected');
  assert.equal(result.permissions[0].outcome.optionId, 'allow-once');
  assert.equal(updates.length, 4);
  assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
  assert.equal(updates[1].sessionUpdate, 'tool_call');
  assert.deepEqual((updates[1].rawInput as { mcpServers: McpServer[] }).mcpServers, mcpServers);
  const latheServer = mcpServers[0];
  assert.ok('command' in latheServer);
  assert.equal(latheServer.name, 'lathe');
  assert.equal(latheServer.command, resolve(repoRoot, 'packages/mcp/node_modules/.bin/tsx'));
  assert.deepEqual(latheServer.args, [resolve(repoRoot, 'packages/mcp/src/server.ts')]);
  assert.deepEqual(latheServer.env, [{ name: 'DATABASE_URL', value: 'postgres://lathe:lathe@localhost:55433/lathe' }]);
});

test('runSession returns selected deny permission outcome to fake ACP agent', async () => {
  let permissionRequest: PermissionRequest | undefined;

  const result = await runSession({
    adapter: fakeAdapter(),
    cwd: repoRoot,
    mcpServers: [],
    prompt: 'Trigger permission deny.',
    onPermission: (request) => {
      permissionRequest = request;
      return { outcome: 'selected', optionId: 'deny-once' };
    },
  });

  const toolUpdate = result.updates.find((update) => update.sessionUpdate === 'tool_call_update');
  assert.ok(permissionRequest);
  assert.equal(result.permissions[0].outcome.outcome, 'selected');
  assert.equal(result.permissions[0].outcome.optionId, 'deny-once');
  assert.equal(toolUpdate?.status, 'failed');
  assert.deepEqual(toolUpdate?.rawOutput, { outcome: { outcome: 'selected', optionId: 'deny-once' } });
});

test('AcpClient sends session/cancel and receives cancelled stop reason', async () => {
  const client = new AcpClient(fakeAdapter({ FAKE_ACP_WAIT_FOR_CANCEL: '1' }), { cwd: repoRoot, timeoutMs: 10_000 });
  try {
    await client.initialize();
    const newSession = await client.newSession({ cwd: repoRoot, mcpServers: [] });
    const sessionId = String(newSession.sessionId);
    const prompt = client.prompt(sessionId, 'Wait until cancelled.');

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.cancel(sessionId);

    const promptResult = await prompt;
    assert.equal(promptResult.stopReason, 'cancelled');
    assert.ok(client.updates.some((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'cancelled'));
  } finally {
    client.close();
  }
});

test('runSession rejects on onUpdate errors without leaving an unhandled incoming promise', async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(
      runSession({
        adapter: fakeAdapter(),
        cwd: repoRoot,
        mcpServers: [],
        prompt: 'Trigger an update callback failure.',
        onUpdate: () => {
          throw new Error('onUpdate exploded');
        },
      }),
      /onUpdate exploded/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('lathe smoke evidence ignores available tool listings and requires a real tool event/result', () => {
  assert.equal(
    hasLatheListSessionsCallEvidence({
      sessionUpdate: 'ext_notification',
      method: '_claude/sdkMessage',
      params: {
        message: {
          type: 'system',
          subtype: 'init',
          tools: ['mcp__lathe__list_sessions'],
          mcp_servers: [{ name: 'lathe', status: 'connected' }],
        },
      },
    }),
    false,
  );

  assert.equal(
    hasLatheListSessionsCallEvidence({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      _meta: { claudeCode: { toolName: 'mcp__lathe__list_sessions' } },
      rawOutput: [{ type: 'text', text: '[]' }],
    }),
    true,
  );

  assert.equal(
    hasLatheListSessionsCallEvidence({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      _meta: {
        claudeCode: {
          toolName: 'mcp__lathe__list_sessions',
          toolResponse: [{ type: 'text', text: '[{"id":"fixture-acp-smoke-session"}]' }],
        },
      },
    }),
    true,
  );

  assert.equal(
    hasLatheListSessionsCallEvidence({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      _meta: { claudeCode: { toolName: 'mcp__lathe__list_sessions' } },
      rawOutput: 'not a list result',
    }),
    false,
  );

  assert.equal(
    hasLatheListSessionsCallEvidence({
      sessionUpdate: 'tool_call_update',
      _meta: {
        claudeCode: {
          toolName: 'mcp__lathe__list_sessions',
          toolResponse: [{ type: 'text', text: '[{"id":"fixture-acp-smoke-session"}]' }],
        },
      },
    }),
    false,
  );
});
