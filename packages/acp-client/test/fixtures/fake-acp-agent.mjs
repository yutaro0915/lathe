import readline from 'node:readline';

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

async function handlePrompt(id, params) {
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
    void handlePrompt(message.id, message.params);
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
