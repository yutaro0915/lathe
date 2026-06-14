import { spawn } from 'node:child_process';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AgentMessage,
  AssistantTurn,
  GenerateOptions,
  LanguageModel,
  ModelStreamEvent,
  ToolCall,
  ToolDefinition,
} from './types.js';

type JsonRecord = Record<string, unknown>;

export interface CliProviderOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface AnthropicApiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  version?: string;
  fetch?: typeof fetch;
}

export class FakeLanguageModel implements LanguageModel {
  private index = 0;

  constructor(private readonly turns: AssistantTurn[] | ((messages: AgentMessage[], tools: ToolDefinition[]) => AssistantTurn | Promise<AssistantTurn>)) {}

  async generate(messages: AgentMessage[], tools: ToolDefinition[]): Promise<AssistantTurn> {
    if (typeof this.turns === 'function') return normalizeTurn(await this.turns(messages, tools));
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    return normalizeTurn(turn);
  }

  async *stream(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): AsyncIterable<ModelStreamEvent> {
    void opts;
    const turn = await this.generate(messages, tools);
    if (turn.content) yield { type: 'text', text: turn.content };
    for (const toolCall of turn.toolCalls) yield { type: 'tool_call', toolCall };
    yield { type: 'done', turn };
  }
}

export class ClaudeCliLanguageModel implements LanguageModel {
  constructor(private readonly options: CliProviderOptions = {}) {}

  async generate(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): Promise<AssistantTurn> {
    const stdout = await runCli(
      this.options.command ?? 'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--input-format',
        'text',
        '--tools',
        '',
        ...(this.options.args ?? []),
      ],
      promptForModel(messages, tools, opts),
      this.options,
      opts?.signal,
    );
    return turnFromPayload(parseMaybeJson(stdout));
  }

  async *stream(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): AsyncIterable<ModelStreamEvent> {
    const stdout = await runCli(
      this.options.command ?? 'claude',
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--tools',
        '',
        ...(this.options.args ?? []),
      ],
      promptForModel(messages, tools, opts),
      this.options,
      opts?.signal,
    );
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = parseMaybeJson(line);
      for (const toolCall of toolCallsFromPayload(event)) {
        toolCalls.push(toolCall);
        yield { type: 'tool_call', toolCall };
      }
      const text = textFromPayload(event);
      if (text) {
        content += text;
        yield { type: 'text', text };
      }
    }
    yield { type: 'done', turn: { role: 'assistant', content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' } };
  }
}

export class CodexExecLanguageModel implements LanguageModel {
  constructor(private readonly options: CliProviderOptions = {}) {}

  async generate(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): Promise<AssistantTurn> {
    const stdout = await runCli(
      this.options.command ?? 'codex',
      ['exec', '--json', ...(this.options.args ?? [])],
      promptForModel(messages, tools, opts),
      this.options,
      opts?.signal,
    );
    return turnFromPayload(parseMaybeJson(stdout));
  }

  async *stream(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): AsyncIterable<ModelStreamEvent> {
    const turn = await this.generate(messages, tools, opts);
    if (turn.content) yield { type: 'text', text: turn.content };
    for (const toolCall of turn.toolCalls) yield { type: 'tool_call', toolCall };
    yield { type: 'done', turn };
  }
}

export class AnthropicApiLanguageModel implements LanguageModel {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly version: string;

  constructor(private readonly options: AnthropicApiProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.version = options.version ?? '2023-06-01';
  }

  async generate(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): Promise<AssistantTurn> {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: opts?.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': this.version,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: opts?.maxTokens ?? 1600,
        temperature: opts?.temperature,
        system: system || undefined,
        messages: messages.filter((message) => message.role !== 'system').map(toAnthropicMessage),
        tools: tools.map(toAnthropicTool),
      }),
    });
    if (!response.ok) throw new Error(`anthropic-api exited with HTTP ${response.status}`);
    return turnFromPayload(await response.json());
  }

  async *stream(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): AsyncIterable<ModelStreamEvent> {
    const turn = await this.generate(messages, tools, opts);
    if (turn.content) yield { type: 'text', text: turn.content };
    for (const toolCall of turn.toolCalls) yield { type: 'tool_call', toolCall };
    yield { type: 'done', turn };
  }
}

export function toolCall(name: string, input: unknown = {}, id = `tool_${name}`): ToolCall {
  return { id, name, input };
}

export function assistantText(content: string): AssistantTurn {
  return { role: 'assistant', content, toolCalls: [], finishReason: 'stop' };
}

export function assistantToolCall(call: ToolCall, content = ''): AssistantTurn {
  return { role: 'assistant', content, toolCalls: [call], finishReason: 'tool_calls' };
}

function promptForModel(messages: AgentMessage[], tools: ToolDefinition[], opts?: GenerateOptions): string {
  const toolText = tools.length
    ? `\n\nAvailable tools JSON:\n${JSON.stringify(toProviderTools(tools), null, 2)}\nReturn tool calls as JSON objects with type="tool_call", name, input, and optional id.`
    : '';
  const responseText = opts?.responseFormat === 'json' ? '\nReturn only valid JSON for the final answer.' : '';
  const history = messages
    .map((message) => {
      const suffix = message.role === 'tool' ? ` ${message.name ?? message.toolCallId ?? ''}`.trimEnd() : '';
      return `${message.role.toUpperCase()}${suffix}: ${message.content}`;
    })
    .join('\n\n');
  return `${history}${toolText}${responseText}`;
}

function toProviderTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
  }));
}

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
  };
}

function toAnthropicMessage(message: AgentMessage) {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    };
  }
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  };
}

function normalizeTurn(turn: AssistantTurn): AssistantTurn {
  return {
    role: 'assistant',
    content: turn.content ?? '',
    toolCalls: turn.toolCalls ?? [],
    finishReason: turn.finishReason ?? ((turn.toolCalls ?? []).length ? 'tool_calls' : 'stop'),
    raw: turn.raw,
  };
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return { content: '' };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { content: trimmed };
  }
}

function turnFromPayload(payload: unknown): AssistantTurn {
  const content = textFromPayload(payload);
  const toolCalls = toolCallsFromPayload(payload);
  return {
    role: 'assistant',
    content,
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    raw: payload,
  };
}

function textFromPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const record = objectValue(payload);
  if (!record) return '';
  if (typeof record.content === 'string') return record.content;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.result === 'string') return record.result;
  if (record.structured_output) return JSON.stringify(record.structured_output);
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        const block = objectValue(item);
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
  }
  const message = objectValue(record.message);
  if (message) return textFromPayload(message);
  return '';
}

function toolCallsFromPayload(payload: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = objectValue(node);
    if (!record) return;
    const type = typeof record.type === 'string' ? record.type : typeof record.event === 'string' ? record.event : '';
    const name = stringValue(record.name) ?? stringValue(record.tool_name) ?? stringValue(record.toolName);
    if (name && (type.includes('tool_use') || type.includes('tool_call'))) {
      calls.push({
        id: stringValue(record.id) ?? `tool_${calls.length + 1}`,
        name,
        input: objectValue(record.input) ?? objectValue(record.arguments) ?? objectValue(record.args) ?? objectValue(record.parameters) ?? {},
      });
    }
    visit(record.content);
    visit(record.message);
    visit(record.delta);
  };
  visit(payload);
  return calls;
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function runCli(
  command: string,
  args: string[],
  stdin: string,
  options: CliProviderOptions,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : undefined;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with status ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(stdin);
  });
}
