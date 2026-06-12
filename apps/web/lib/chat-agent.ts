import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALLOWED_AGENT_TOOL_NAMES,
  LATHE_AGENT_MCP_SERVER_NAME,
  LATHE_MCP_TOOL_NAMES,
  assertAllowedAgentTool,
  invokeLatheMcpTool,
  type LatheMcpToolName,
} from './chat-tools';
import { getSession, listFindings } from './db';
import type { ChatMessage, Finding, Session } from './types';

type JsonRecord = Record<string, unknown>;

export type ChatProviderName = 'fake' | 'claude' | 'codex';

export interface ChatAgentRequestInput {
  threadId: string;
  provider?: ChatProviderName;
  messages: ChatMessage[];
  sessionId?: string | null;
  findingId?: number | null;
}

export interface ChatAgentRequest {
  threadId: string;
  provider: ChatProviderName;
  messages: { role: ChatMessage['role']; body: string }[];
  latestUserMessage: string;
  contextText: string;
  attachedSession: Session | null;
  attachedFinding: Finding | null;
}

export type ChatAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: JsonRecord }
  | { type: 'tool_result'; name: LatheMcpToolName; result: unknown };

export interface AgentLaunchConfig {
  provider: Exclude<ChatProviderName, 'fake'>;
  command: string;
  args: string[];
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
    }
  >;
  allowedTools: readonly `mcp__lathe__${LatheMcpToolName}`[];
  disallowedTools: readonly string[];
}

const DEFAULT_PROVIDER: ChatProviderName = 'claude';

function cleanProvider(value: string | undefined): ChatProviderName | undefined {
  if (value === 'fake' || value === 'claude' || value === 'codex') return value;
  return undefined;
}

export function resolveChatProviderName(value?: string): ChatProviderName {
  return cleanProvider(value) ?? cleanProvider(process.env.LATHE_CHAT_PROVIDER) ?? DEFAULT_PROVIDER;
}

export function buildAgentLaunchConfig(provider: Exclude<ChatProviderName, 'fake'>): AgentLaunchConfig {
  const mcpServers = {
    [LATHE_AGENT_MCP_SERVER_NAME]: {
      command: 'pnpm',
      args: ['-F', '@lathe/mcp', 'stdio'],
    },
  };
  const allowed = ALLOWED_AGENT_TOOL_NAMES;
  if (provider === 'claude') {
    return {
      provider,
      command: 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--mcp-config',
        '<lathe-mcp-config>',
        '--allowedTools',
        allowed.join(','),
      ],
      mcpServers,
      allowedTools: allowed,
      disallowedTools: [],
    };
  }
  return {
    provider,
    command: 'codex',
    args: ['exec', '--json', '--mcp-config', '<lathe-mcp-config>', '--allowed-tools', allowed.join(',')],
    mcpServers,
    allowedTools: allowed,
    disallowedTools: [],
  };
}

function systemPrompt(): string {
  return [
    'You are the Lathe chat analyst.',
    'Analyze observed coding-agent sessions and findings only.',
    `Your only tools are the Lathe MCP tools: ${LATHE_MCP_TOOL_NAMES.join(', ')}.`,
    'Do not edit files, run shell commands, read arbitrary files, or browse the Web.',
    'If you find a concrete issue, submit it with submit_finding so it enters the normal verdict flow.',
  ].join('\n');
}

function compactFinding(finding: Finding): string {
  return [
    `finding_id=${finding.id}`,
    `kind=${finding.kind}`,
    `analyst=${finding.analyst}`,
    `confidence=${finding.confidence}`,
    `title=${finding.title}`,
  ].join(' ');
}

export async function buildChatAgentRequest(input: ChatAgentRequestInput): Promise<ChatAgentRequest> {
  const attachedSession = input.sessionId ? (await getSession(input.sessionId)) ?? null : null;
  const attachedFinding =
    input.findingId != null ? (await listFindings()).find((finding) => finding.id === input.findingId) ?? null : null;
  const latestUserMessage = [...input.messages].reverse().find((message) => message.role === 'user')?.body ?? '';
  const contextLines = [systemPrompt()];
  if (attachedSession) {
    contextLines.push(
      `Attached session: session_id=${attachedSession.id} title=${JSON.stringify(attachedSession.title)} runner=${attachedSession.runner} model=${attachedSession.model ?? 'unknown'} cost_usd=${attachedSession.costUsd ?? 'unknown'}`,
    );
  } else if (input.sessionId) {
    contextLines.push(`Attached session: session_id=${input.sessionId} (not found)`);
  }
  if (attachedFinding) {
    contextLines.push(`Attached finding: ${compactFinding(attachedFinding)}`);
  } else if (input.findingId != null) {
    contextLines.push(`Attached finding: finding_id=${input.findingId} (not found)`);
  }
  return {
    threadId: input.threadId,
    provider: resolveChatProviderName(input.provider),
    messages: input.messages.map((message) => ({ role: message.role, body: message.body })),
    latestUserMessage,
    contextText: contextLines.join('\n'),
    attachedSession,
    attachedFinding,
  };
}

export function chatAgentRequestMeta(request: ChatAgentRequest): JsonRecord {
  return {
    provider: request.provider,
    threadId: request.threadId,
    contextText: request.contextText,
    session: request.attachedSession
      ? {
          id: request.attachedSession.id,
          title: request.attachedSession.title,
          runner: request.attachedSession.runner,
          model: request.attachedSession.model,
        }
      : null,
    finding: request.attachedFinding
      ? {
          id: request.attachedFinding.id,
          kind: request.attachedFinding.kind,
          title: request.attachedFinding.title,
        }
      : null,
    messages: request.messages.map((message) => ({ role: message.role, body: message.body })),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkedToolCall(name: string, args: JsonRecord): Promise<{ name: LatheMcpToolName; result: unknown }> {
  const allowedName = assertAllowedAgentTool(name);
  const result = await invokeLatheMcpTool(allowedName, args);
  return { name: allowedName, result };
}

async function* fakeProvider(request: ChatAgentRequest): AsyncGenerator<ChatAgentEvent> {
  const text = request.latestUserMessage.toLowerCase();
  if (text.includes('forbidden')) {
    yield { type: 'tool_call', name: 'bash', args: { command: 'ls' } };
    await checkedToolCall('bash', { command: 'ls' });
    return;
  }

  if (text.includes('stream')) {
    for (const chunk of ['stream chunk 1 ', 'stream chunk 2 ', 'stream complete']) {
      await delay(120);
      yield { type: 'text', text: chunk };
    }
    return;
  }

  if (text.includes('submit finding')) {
    const sessionId = request.attachedSession?.id;
    if (!sessionId) {
      yield { type: 'text', text: 'No attached session is available for the finding fixture.' };
      return;
    }
    const title = `Chat submitted finding ${request.threadId.slice(-8)}`;
    const args = {
      finding: {
        analyst: 'chat-fake-provider',
        kind: 'risky_action',
        title,
        body: 'Fake chat provider submitted this finding through the Lathe MCP tool boundary.',
        confidence: 0.77,
        evidence: [
          {
            subject_kind: 'session',
            session_id: sessionId,
            subject_id: sessionId,
            locator: { session_id: sessionId },
            note: 'chat fake provider evidence',
          },
        ],
      },
    };
    yield { type: 'tool_call', name: 'submit_finding', args };
    const tool = await checkedToolCall('submit_finding', args);
    yield { type: 'tool_result', name: tool.name, result: tool.result };
    yield { type: 'text', text: `Submitted finding: ${title}` };
    return;
  }

  if (request.attachedSession && /bundle|session|attach|attached|analy[sz]e/.test(text)) {
    const args = { session_id: request.attachedSession.id };
    yield { type: 'tool_call', name: 'get_session_bundle', args };
    const tool = await checkedToolCall('get_session_bundle', args);
    yield { type: 'tool_result', name: tool.name, result: tool.result };
    const bundle = tool.result as { session?: { title?: string; id?: string }; events?: unknown[] };
    yield {
      type: 'text',
      text: `Session bundle loaded: ${bundle.session?.title ?? request.attachedSession.title} (${bundle.events?.length ?? 0} events).`,
    };
    return;
  }

  const reply = `Fake analysis: ${request.latestUserMessage.trim() || 'ready'}`;
  yield { type: 'text', text: reply.slice(0, Math.max(14, Math.ceil(reply.length / 2))) };
  await delay(80);
  yield { type: 'text', text: reply.slice(Math.max(14, Math.ceil(reply.length / 2))) };
}

function promptForCli(request: ChatAgentRequest): string {
  const history = request.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.body}`)
    .join('\n\n');
  return `${request.contextText}\n\nConversation:\n${history}\n\nASSISTANT:`;
}

function writeMcpConfig(config: AgentLaunchConfig): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-chat-mcp-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        mcpServers: config.mcpServers,
      },
      null,
      2,
    ),
  );
  return { file, dir };
}

function textFromProviderLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const json = JSON.parse(trimmed) as JsonRecord;
    const direct =
      typeof json.text === 'string'
        ? json.text
        : typeof json.delta === 'string'
          ? json.delta
          : typeof json.content === 'string'
            ? json.content
            : '';
    if (direct) return direct;
    const message = json.message;
    if (message && typeof message === 'object') {
      const content = (message as JsonRecord).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((item) => (item && typeof item === 'object' && typeof (item as JsonRecord).text === 'string' ? (item as JsonRecord).text : ''))
          .join('');
      }
    }
    return '';
  } catch {
    return line;
  }
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function toolNameFromRecord(record: JsonRecord): string | undefined {
  for (const key of ['name', 'tool_name', 'toolName']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function toolArgsFromRecord(record: JsonRecord): JsonRecord {
  return (
    objectValue(record.input) ??
    objectValue(record.arguments) ??
    objectValue(record.args) ??
    objectValue(record.parameters) ??
    {}
  );
}

function providerToolEvents(value: unknown): ChatAgentEvent[] {
  const events: ChatAgentEvent[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = objectValue(node);
    if (!record) return;

    const rawType =
      typeof record.type === 'string'
        ? record.type
        : typeof record.event === 'string'
          ? record.event
          : '';
    const type = rawType.toLowerCase();
    const rawName = toolNameFromRecord(record);
    if (rawName && (type.includes('tool_use') || type.includes('tool_call'))) {
      const name = assertAllowedAgentTool(rawName);
      events.push({ type: 'tool_call', name, args: toolArgsFromRecord(record) });
    } else if (rawName && type.includes('tool_result')) {
      const name = assertAllowedAgentTool(rawName);
      events.push({ type: 'tool_result', name, result: record.result ?? record.output ?? record.content ?? record });
    }

    visit(record.content);
    visit(record.message);
    visit(record.delta);
  };
  visit(value);
  return events;
}

function toolEventsFromProviderLine(line: string): ChatAgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    return providerToolEvents(JSON.parse(trimmed) as JsonRecord);
  } catch {
    return [];
  }
}

async function* cliProvider(request: ChatAgentRequest): AsyncGenerator<ChatAgentEvent> {
  const provider = request.provider === 'codex' ? 'codex' : 'claude';
  const config = buildAgentLaunchConfig(provider);
  const mcpConfig = writeMcpConfig(config);
  const prompt = promptForCli(request);
  const args =
    provider === 'claude'
      ? [...config.args.map((arg) => (arg === '<lathe-mcp-config>' ? mcpConfig.file : arg)), prompt]
      : [...config.args.map((arg) => (arg === '<lathe-mcp-config>' ? mcpConfig.file : arg)), prompt];
  try {
    const child = spawn(config.command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LATHE_INTERNAL_AGENT: 'chat',
        LATHE_INTERNAL_PROJECT: 'lathe-internal',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += String(chunk);
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const event of toolEventsFromProviderLine(line)) yield event;
        const text = textFromProviderLine(line);
        if (text) yield { type: 'text', text };
      }
    }
    for (const event of toolEventsFromProviderLine(buffer)) yield event;
    const tail = textFromProviderLine(buffer);
    if (tail) yield { type: 'text', text: tail };
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    if (status !== 0) throw new Error(`${provider} chat provider exited with status ${status}: ${stderr.trim()}`);
  } finally {
    fs.rmSync(mcpConfig.dir, { recursive: true, force: true });
  }
}

export async function* streamChatAgent(request: ChatAgentRequest): AsyncGenerator<ChatAgentEvent> {
  if (request.provider === 'fake') {
    yield* fakeProvider(request);
    return;
  }
  yield* cliProvider(request);
}
