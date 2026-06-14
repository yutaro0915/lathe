import type { ZodType } from 'zod';
import { buildAgentContext, type AgentContextInput } from './context.js';
import { runLoop, type AgentEvent, type LoopResult } from './loop.js';
import { ToolRegistry, type Tool } from './tool.js';
import type { LanguageModel } from './types.js';

export type { AgentContext, AgentContextInput } from './context.js';
export type { AgentEvent, LoopOptions, LoopResult } from './loop.js';
export { runLoop } from './loop.js';
export { NeutralMcpClient, type McpClientConfig, type McpTransportConfig } from './mcp-client.js';
export {
  AnthropicApiLanguageModel,
  ClaudeCliLanguageModel,
  CodexExecLanguageModel,
  FakeLanguageModel,
  assistantText,
  assistantToolCall,
  toolCall,
  type AnthropicApiProviderOptions,
  type CliProviderOptions,
} from './provider.js';
export { ToolRegistry, defineTool, jsonSchemaToZod, mcpToolToTool, mcpToolsToRegistry, type Tool } from './tool.js';
export type {
  AgentMessage,
  AgentRole,
  AgentStopReason,
  AssistantTurn,
  GenerateOptions,
  LanguageModel,
  ModelStreamEvent,
  ToolCall,
  ToolDefinition,
  ToolExecutionRecord,
} from './types.js';

export interface AgentConfig<Deps = unknown, Output = unknown> extends AgentContextInput<Deps> {
  model: LanguageModel;
  tools?: Tool<Deps>[];
  registry?: ToolRegistry<Deps>;
  maxSteps?: number;
  output?: ZodType<Output>;
}

export interface RunResult<Output = unknown> extends LoopResult {
  content: string;
  output?: Output;
}

export async function runAgent<Deps = unknown, Output = unknown>(config: AgentConfig<Deps, Output>): Promise<RunResult<Output>> {
  const registry = config.registry ?? new ToolRegistry<Deps>(config.tools ?? []);
  const loop = await runLoop({
    model: config.model,
    registry,
    context: buildAgentContext(config),
    maxSteps: config.maxSteps,
  });
  const parsed = config.output ? config.output.parse(extractJson(loop.finalTurn.content)) : undefined;
  return {
    ...loop,
    content: loop.finalTurn.content,
    output: parsed,
  };
}

export async function* streamAgent<Deps = unknown, Output = unknown>(config: AgentConfig<Deps, Output>): AsyncIterable<AgentEvent> {
  const queue = new AsyncEventQueue<AgentEvent>();
  const registry = config.registry ?? new ToolRegistry<Deps>(config.tools ?? []);
  void runLoop({
    model: config.model,
    registry,
    context: buildAgentContext(config),
    maxSteps: config.maxSteps,
    onEvent: (event) => queue.push(event),
  })
    .then(() => queue.close())
    .catch((error) => queue.fail(error));

  for await (const event of queue) yield event;
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new Error('final assistant message did not contain JSON');
    return JSON.parse(match[0]);
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private error: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    this.error = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.error) throw this.error;
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
