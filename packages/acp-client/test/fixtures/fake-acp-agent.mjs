import readline from 'node:readline';
import { spawn } from 'node:child_process';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let sessionId = 'fake-session-1';
let newSessionParams = null;
let pendingPromptId = null;
let pendingPermissionResolve = null;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function result(id, value) {
  send({ id, result: value });
}

function update(update) {
  send({ method: 'session/update', params: { sessionId, update } });
}

class McpClient {
  constructor(server) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    const env = Object.fromEntries((server.env ?? []).map((item) => [item.name, item.value]));
    this.child = spawn(server.command, server.args ?? [], {
      cwd: newSessionParams?.cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('close', (code) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`MCP server exited with code ${code}; stderr=${this.stderr.trim()}`));
        this.pending.delete(id);
      }
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for MCP ${method}; stderr=${this.stderr.trim()}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-acp-agent', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async callTool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`MCP ${name} error: ${response.error.message ?? JSON.stringify(response.error)}`);
    if (response.result?.isError) {
      const text = response.result.content?.find((item) => item?.type === 'text')?.text;
      throw new Error(`MCP ${name} tool error: ${text ?? JSON.stringify(response.result)}`);
    }
    return response;
  }

  close() {
    if (!this.child.killed) this.child.kill('SIGTERM');
  }
}

function requestPermission() {
  return new Promise((resolve) => {
    pendingPermissionResolve = resolve;
    send({
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fake-tool-1',
          title: 'Use fake permissioned tool',
          kind: 'other',
          status: 'pending',
          rawInput: { mcpServers: newSessionParams?.mcpServers ?? [] },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-once', name: 'Deny once', kind: 'reject_once' },
        ],
      },
    });
  });
}

function promptText(prompt) {
  return (prompt ?? [])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function promptAnalyst(text) {
  return text.match(/analyst must be "([^"]+)"/)?.[1] ?? 'llm-v1';
}

function promptSessionIds(text) {
  return [...new Set([...text.matchAll(/session_id=([^\s|]+)/g)].map((match) => match[1]).filter(Boolean))];
}

function promptPayloads(text) {
  return [...text.matchAll(/^payload_\d+=(\{.*\})$/gm)].map((match) => JSON.parse(match[1].replace(/:undefined(?=,|})/g, ':null')));
}

function sentinelAnalysis(analyst) {
  return {
    cause_hypothesis: `fake-acp-agent ${analyst} sentinel cause: pnpm fixture-depth failed repeatedly in the ACP submit path.`,
    agent_intent: `fake-acp-agent ${analyst} sentinel intent: exercise deterministic verify-finding-depth wiring for the user's depth smoke task.`,
    impact: `fake-acp-agent ${analyst} sentinel impact: preserves agent-submitted env/runtime/setup analysis instead of replacing it with product/harness backfill.`,
  };
}

function dropNullOptional(record, keys) {
  const next = { ...record };
  for (const key of keys) {
    if (next[key] === null || next[key] === undefined) delete next[key];
  }
  return next;
}

function findingPayloadsForPrompt(params) {
  const text = promptText(params.prompt);
  const analyst = promptAnalyst(text);
  const payloads = promptPayloads(text);
  if (payloads.length) {
    return payloads.map((payload, index) => ({
      ...dropNullOptional(payload, ['project_id']),
      analyst,
      analysis: sentinelAnalysis(analyst),
      evidence: (payload.evidence ?? []).map((item) => ({
        ...dropNullOptional(item, ['subject_id', 'session_id', 'note']),
        note: `fake ACP preserved payload evidence ${index}`,
      })),
    }));
  }
  const sessionId = promptSessionIds(text)[0];
  if (!sessionId) throw new Error('fake ACP analyst submit mode could not find a session_id in the prompt');
  return [
    {
      analyst,
      kind: 'failure_loop',
      title: `Fake ACP submitted ${analyst} finding`,
      body: 'Fake ACP agent observed repeated pnpm fixture-depth failures while exercising the ACP submit_finding path.',
      confidence: 0.91,
      analysis: sentinelAnalysis(analyst),
      evidence: [
        {
          subject_kind: 'turn',
          session_id: sessionId,
          locator: { seq: 2 },
          note: 'fake ACP submitted deterministic turn evidence',
        },
      ],
    },
  ];
}

async function handleAnalystSubmitPrompt(id, params) {
  update({
    sessionUpdate: 'user_message_chunk',
    messageId: 'fake-user-1',
    content: params.prompt[0],
  });
  const server = (newSessionParams?.mcpServers ?? []).find((item) => item.name === 'lathe');
  if (!server || server.type === 'http' || server.type === 'sse') {
    throw new Error('fake ACP analyst submit mode requires a stdio lathe MCP server');
  }
  const client = new McpClient(server);
  try {
    await client.initialize();
    const payloads = findingPayloadsForPrompt(params);
    for (let index = 0; index < payloads.length; index++) {
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: `fake-submit-${index}`,
        status: 'pending',
        _meta: { claudeCode: { toolName: 'mcp__lathe__submit_finding' } },
      });
      await client.callTool('submit_finding', { finding: payloads[index] });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: `fake-submit-${index}`,
        status: 'completed',
        _meta: { claudeCode: { toolName: 'mcp__lathe__submit_finding' } },
      });
    }
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'fake-agent-1',
      content: {
        type: 'text',
        text: `submitted=${payloads.length}`,
      },
    });
    result(id, { stopReason: 'end_turn' });
  } finally {
    client.close();
  }
}

async function handlePrompt(id, params) {
  if (process.env.FAKE_ACP_SUBMIT_FINDINGS === '1') {
    await handleAnalystSubmitPrompt(id, params);
    return;
  }
  update({
    sessionUpdate: 'user_message_chunk',
    messageId: 'fake-user-1',
    content: params.prompt[0],
  });
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'fake-tool-1',
    title: 'Inspect received MCP servers',
    kind: 'other',
    status: 'pending',
    rawInput: { mcpServers: newSessionParams?.mcpServers ?? [] },
  });
  const permissionResponse = await requestPermission();
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'fake-tool-1',
    status: permissionResponse?.result?.outcome?.optionId === 'deny-once' ? 'failed' : 'completed',
    rawOutput: permissionResponse?.result ?? {},
  });
  update({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'fake-agent-1',
    content: {
      type: 'text',
      text: `permission=${permissionResponse?.result?.outcome?.optionId ?? 'none'}`,
    },
  });

  if (process.env.FAKE_ACP_WAIT_FOR_CANCEL === '1') {
    pendingPromptId = id;
    return;
  }

  result(id, { stopReason: 'end_turn' });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id === 'permission-1' && pendingPermissionResolve) {
    pendingPermissionResolve(message);
    pendingPermissionResolve = null;
    return;
  }

  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
      },
      agentInfo: { name: 'fake-acp-agent', title: 'Fake ACP Agent', version: '0.0.0' },
      authMethods: [],
    });
    return;
  }

  if (message.method === 'session/new') {
    newSessionParams = message.params;
    result(message.id, { sessionId });
    return;
  }

  if (message.method === 'session/prompt') {
    void handlePrompt(message.id, message.params).catch((error) => {
      send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    });
    return;
  }

  if (message.method === 'session/cancel') {
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fake-tool-1',
      status: 'cancelled',
    });
    if (pendingPromptId !== null) {
      result(pendingPromptId, { stopReason: 'cancelled' });
      pendingPromptId = null;
    }
    return;
  }

  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
  }
});
