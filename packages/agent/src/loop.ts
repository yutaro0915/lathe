import type { AgentContext } from './context.js';
import type { ToolRegistry } from './tool.js';
import type { AgentMessage, AgentStopReason, AssistantTurn, LanguageModel, ToolExecutionRecord } from './types.js';

export type AgentEvent =
  | { type: 'text'; text: string; step: number }
  | { type: 'tool_call'; call: ToolExecutionRecord['call']; step: number }
  | { type: 'tool_result'; call: ToolExecutionRecord['call']; result?: unknown; error?: string; step: number }
  | { type: 'done'; result: LoopResult };

export interface LoopOptions<Deps = unknown> {
  model: LanguageModel;
  registry: ToolRegistry<Deps>;
  context: AgentContext<Deps>;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface LoopResult {
  stopReason: AgentStopReason;
  steps: number;
  messages: AgentMessage[];
  finalTurn: AssistantTurn;
  toolResults: ToolExecutionRecord[];
}

export async function runLoop<Deps = unknown>(options: LoopOptions<Deps>): Promise<LoopResult> {
  const maxSteps = options.maxSteps ?? 20;
  if (maxSteps < 1) throw new Error('maxSteps must be at least 1');
  const messages = [...options.context.messages];
  const toolResults: ToolExecutionRecord[] = [];
  let finalTurn: AssistantTurn = { role: 'assistant', content: '', toolCalls: [], finishReason: 'stop' };

  for (let step = 1; step <= maxSteps; step += 1) {
    const turn = await options.model.generate(messages, options.registry.definitions(), {
      signal: options.context.signal,
    });
    finalTurn = {
      role: 'assistant',
      content: turn.content ?? '',
      toolCalls: turn.toolCalls ?? [],
      finishReason: turn.finishReason,
      raw: turn.raw,
    };
    if (finalTurn.content) await emit(options.onEvent, { type: 'text', text: finalTurn.content, step });
    messages.push({
      role: 'assistant',
      content: finalTurn.content,
      toolCalls: finalTurn.toolCalls,
    });

    if (finalTurn.toolCalls.length === 0) {
      const result = { stopReason: 'final' as const, steps: step, messages, finalTurn, toolResults };
      await emit(options.onEvent, { type: 'done', result });
      return result;
    }

    for (const call of finalTurn.toolCalls) {
      await emit(options.onEvent, { type: 'tool_call', call, step });
      try {
        const value = await options.registry.executeTool(call, {
          deps: options.context.deps,
          signal: options.context.signal,
        });
        toolResults.push({ call, result: value });
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: serializeToolResult(value),
        });
        await emit(options.onEvent, { type: 'tool_result', call, result: value, step });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolResults.push({ call, error: message });
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify({ error: message }),
        });
        await emit(options.onEvent, { type: 'tool_result', call, error: message, step });
      }
    }
  }

  const result = { stopReason: 'max_steps' as const, steps: maxSteps, messages, finalTurn, toolResults };
  await emit(options.onEvent, { type: 'done', result });
  return result;
}

async function emit(handler: LoopOptions['onEvent'], event: AgentEvent): Promise<void> {
  if (handler) await handler(event);
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
