import type { AgentMessage } from './types.js';

export interface AgentContext<Deps = unknown> {
  instructions?: string;
  messages: AgentMessage[];
  deps: Deps;
  signal?: AbortSignal;
}

export interface AgentContextInput<Deps = unknown> {
  instructions?: string;
  messages?: AgentMessage[];
  deps?: Deps;
  signal?: AbortSignal;
}

export function buildAgentContext<Deps = unknown>(input: AgentContextInput<Deps>): AgentContext<Deps> {
  return {
    instructions: input.instructions,
    messages: [
      ...(input.instructions ? [{ role: 'system' as const, content: input.instructions }] : []),
      ...(input.messages ?? []),
    ],
    deps: input.deps as Deps,
    signal: input.signal,
  };
}
