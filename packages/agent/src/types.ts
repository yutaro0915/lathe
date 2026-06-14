import type { ZodTypeAny } from 'zod';

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
}

export interface AssistantTurn {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  raw?: unknown;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; turn: AssistantTurn };

export interface LanguageModel {
  generate(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): Promise<AssistantTurn>;
  stream(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): AsyncIterable<ModelStreamEvent>;
}

export type AgentStopReason = 'final' | 'max_steps';

export interface ToolExecutionRecord {
  call: ToolCall;
  result?: unknown;
  error?: string;
}
