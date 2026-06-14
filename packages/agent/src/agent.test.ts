import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AnthropicApiLanguageModel,
  ClaudeCliLanguageModel,
  CodexExecLanguageModel,
  FakeLanguageModel,
  NeutralMcpClient,
  ToolRegistry,
  assistantText,
  assistantToolCall,
  defineTool,
  mcpToolToTool,
  runAgent,
  runLoop,
  streamAgent,
  toolCall,
  type LanguageModel,
} from './index.js';
import { collectChatLiteEvents } from '../examples/chat-lite.js';
import { runAnalystLite } from '../examples/analyst-lite.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('acceptance 1: provider implementations satisfy one LanguageModel interface and fake loop is deterministic', async () => {
  const providers: LanguageModel[] = [
    new ClaudeCliLanguageModel(),
    new AnthropicApiLanguageModel({
      apiKey: 'fixture-key',
      model: 'fixture-model',
      fetch: async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'api fixture' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    }),
    new CodexExecLanguageModel(),
    new FakeLanguageModel([assistantText('fake fixture')]),
  ];
  assert.equal(providers.length, 4);

  const result = await runLoop({
    model: providers[3],
    registry: new ToolRegistry(),
    context: { messages: [{ role: 'user', content: 'hello' }], deps: {} },
  });
  assert.equal(result.stopReason, 'final');
  assert.equal(result.finalTurn.content, 'fake fixture');
});

test('acceptance 2: MCP client lists package MCP tools over neutral stdio and can call a tool boundary', async () => {
  const client = new NeutralMcpClient({
    transport: {
      type: 'stdio',
      command: 'pnpm',
      args: ['--dir', repoRoot, '-F', '@lathe/mcp', 'stdio'],
    },
  });
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['get_evidence_context', 'get_session_bundle', 'list_sessions', 'query_findings', 'submit_finding'].sort(),
    );
    await assert.rejects(() => client.callTool('get_session_bundle', {}), /session_id|Invalid arguments|error/i);

    const registry = new ToolRegistry([
      defineTool({
        name: 'real_mcp_error',
        description: 'Call a real MCP tool with invalid arguments',
        inputSchema: z.object({}),
        execute: async () => client.callTool('get_session_bundle', {}),
      }),
    ]);
    const events: Array<{ error?: string }> = [];
    const result = await runLoop({
      model: new FakeLanguageModel([assistantToolCall(toolCall('real_mcp_error', {}, 'real-mcp-1')), assistantText('done')]),
      registry,
      context: { messages: [{ role: 'user', content: 'trigger real MCP error' }], deps: {} },
      onEvent: (event) => {
        if (event.type === 'tool_result') events.push(event);
      },
    });
    assert.equal(result.toolResults.length, 1);
    assert.match(result.toolResults[0]?.error ?? '', /session_id|Invalid arguments|error/i);
    assert.match(events[0]?.error ?? '', /session_id|Invalid arguments|error/i);
  } finally {
    await client.close();
  }

  const source = readPackageSource();
  assert.equal(source.includes(['mcp', '__'].join('')), false);
  assert.equal(source.includes(['allowed', 'Tools'].join('')), false);
  assert.equal(source.includes(['Claude', 'Code'].join(' ')), false);
});

test('acceptance 3: local tools and MCP tools normalize to one registry surface', async () => {
  const localTool = defineTool({
    name: 'local_echo',
    description: 'Echo local input',
    inputSchema: z.object({ value: z.string() }),
    execute: async (input) => ({ local: (input as { value: string }).value }),
  });
  const mcpTool = mcpToolToTool(
    {
      name: 'remote_echo',
      description: 'Echo remote input',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      callTool: async (_name, input) => ({ remote: (input as { value: string }).value }),
    },
  );
  const registry = new ToolRegistry([localTool, mcpTool]);
  const model = new FakeLanguageModel((messages) => {
    if (!messages.some((message) => message.role === 'tool' && message.name === 'local_echo')) {
      return assistantToolCall(toolCall('local_echo', { value: 'a' }, 'local-1'));
    }
    if (!messages.some((message) => message.role === 'tool' && message.name === 'remote_echo')) {
      return assistantToolCall(toolCall('remote_echo', { value: 'b' }, 'remote-1'));
    }
    return assistantText('done');
  });
  const result = await runLoop({
    model,
    registry,
    context: { messages: [{ role: 'user', content: 'run both tools' }], deps: {} },
  });
  assert.equal(result.stopReason, 'final');
  assert.deepEqual(result.toolResults.map((item) => item.result), [{ local: 'a' }, { remote: 'b' }]);

  const errorRegistry = new ToolRegistry([
    defineTool({
      name: 'local_fail',
      description: 'Fail locally',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('local exploded');
      },
    }),
    mcpToolToTool(
      {
        name: 'remote_fail',
        description: 'Fail through an MCP-like tool',
        inputSchema: { type: 'object' },
      },
      {
        callTool: async () => {
          throw new Error('mcp exploded');
        },
      },
    ),
  ]);
  const errorModel = new FakeLanguageModel((messages) => {
    if (!messages.some((message) => message.role === 'tool' && message.name === 'local_fail')) {
      return assistantToolCall(toolCall('local_fail', {}, 'local-fail-1'));
    }
    if (!messages.some((message) => message.role === 'tool' && message.name === 'remote_fail')) {
      return assistantToolCall(toolCall('remote_fail', {}, 'remote-fail-1'));
    }
    return assistantText('done');
  });
  const errorResult = await runLoop({
    model: errorModel,
    registry: errorRegistry,
    context: { messages: [{ role: 'user', content: 'compare error surfaces' }], deps: {} },
  });
  assert.deepEqual(errorResult.toolResults.map((item) => item.error), ['local exploded', 'mcp exploded']);
  assert.deepEqual(errorResult.toolResults.map((item) => 'result' in item), [false, false]);
});

test('acceptance 4: loop stops on final message or maxSteps', async () => {
  const final = await runLoop({
    model: new FakeLanguageModel([assistantText('finished')]),
    registry: new ToolRegistry(),
    context: { messages: [{ role: 'user', content: 'finish' }], deps: {} },
  });
  assert.equal(final.stopReason, 'final');
  assert.equal(final.steps, 1);

  const registry = new ToolRegistry([
    defineTool({
      name: 'tick',
      description: 'Return a tick',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    }),
  ]);
  const capped = await runLoop({
    model: new FakeLanguageModel([assistantToolCall(toolCall('tick', {}, 'tick-1'))]),
    registry,
    context: { messages: [{ role: 'user', content: 'loop' }], deps: {} },
    maxSteps: 2,
  });
  assert.equal(capped.stopReason, 'max_steps');
  assert.equal(capped.steps, 2);
  assert.equal(capped.toolResults.length, 2);
});

test('acceptance 5: runAgent structured output and streamAgent events share the same core', async () => {
  const output = z.object({ answer: z.string() });
  const runResult = await runAgent({
    model: new FakeLanguageModel([assistantText(JSON.stringify({ answer: 'typed' }))]),
    messages: [{ role: 'user', content: 'json' }],
    deps: {},
    output,
  });
  assert.deepEqual(runResult.output, { answer: 'typed' });

  const events = [];
  for await (const event of streamAgent({
    model: new FakeLanguageModel([assistantText('streamed')]),
    messages: [{ role: 'user', content: 'stream' }],
    deps: {},
  })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ['text', 'done']);
});

test('acceptance 6: analyst-lite and chat-lite consumers run on the core with fake provider', async () => {
  const analyst = await runAnalystLite();
  assert.equal(analyst.output?.findings[0]?.title, 'Fixture finding');

  const chatEvents = await collectChatLiteEvents();
  assert.deepEqual(chatEvents.map((event) => event.type), ['text', 'done']);
});

function readPackageSource(): string {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === 'dist' || entry === 'node_modules') continue;
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  visit(resolve(repoRoot, 'packages/agent'));
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}
