import { once } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { StdioJsonRpc } from './json-rpc.js';
import type {
  AdapterCommand,
  ContentBlock,
  JsonRecord,
  JsonValue,
  McpServer,
  PermissionOutcome,
  PermissionRequest,
  RunSessionOptions,
  SessionResult,
  SessionUpdate,
} from './types.js';

type IncomingRequest = {
  id?: string | number;
  method: string;
  params?: JsonValue;
};

function asRecord(value: JsonValue | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizePrompt(prompt: string | ContentBlock[]): ContentBlock[] {
  return typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
}

function defaultPermission(request: PermissionRequest): PermissionOutcome {
  const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always') ?? request.options[0];
  if (!allow) return { outcome: 'cancelled' };
  return { outcome: 'selected', optionId: allow.optionId };
}

export function latheMcpServer(options: { repoRoot: string; databaseUrl?: string }): McpServer {
  const repoRoot = isAbsolute(options.repoRoot) ? options.repoRoot : resolve(options.repoRoot);
  const env = options.databaseUrl ? [{ name: 'DATABASE_URL', value: options.databaseUrl }] : [];
  const tsxBin = resolve(repoRoot, 'packages/mcp/node_modules/.bin/tsx');
  return {
    name: 'lathe',
    command: tsxBin,
    args: [resolve(repoRoot, 'packages/mcp/src/server.ts')],
    env,
  };
}

export class AcpClient {
  readonly rpc: StdioJsonRpc;
  readonly updates: SessionUpdate[] = [];
  readonly permissions: SessionResult['permissions'] = [];

  #onUpdate?: RunSessionOptions['onUpdate'];
  #onPermission?: RunSessionOptions['onPermission'];

  constructor(adapter: AdapterCommand, options: Pick<RunSessionOptions, 'cwd' | 'timeoutMs' | 'onUpdate' | 'onPermission'>) {
    this.#onUpdate = options.onUpdate;
    this.#onPermission = options.onPermission;
    this.rpc = new StdioJsonRpc(adapter, { cwd: options.cwd, timeoutMs: options.timeoutMs });
    this.rpc.on('message', (message: IncomingRequest) => {
      void this.#handleIncoming(message).catch((error) => {
        this.rpc.fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  initialize(): Promise<JsonRecord> {
    return this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'lathe-acp-client',
        title: 'Lathe ACP Client',
        version: '0.0.0',
      },
    });
  }

  newSession(params: { cwd: string; mcpServers: McpServer[]; sessionMeta?: JsonRecord }): Promise<JsonRecord> {
    const cwd = isAbsolute(params.cwd) ? params.cwd : resolve(params.cwd);
    const request: JsonRecord = {
      cwd,
      mcpServers: params.mcpServers,
    };
    if (params.sessionMeta) request._meta = params.sessionMeta;
    return this.rpc.request('session/new', request);
  }

  prompt(sessionId: string, prompt: string | ContentBlock[]): Promise<JsonRecord> {
    return this.rpc.request('session/prompt', {
      sessionId,
      prompt: normalizePrompt(prompt),
    });
  }

  cancel(sessionId: string): void {
    this.rpc.notify('session/cancel', { sessionId });
  }

  close(): void {
    this.rpc.close();
  }

  async #handleIncoming(message: IncomingRequest): Promise<void> {
    if (message.method === 'session/update') {
      const params = asRecord(message.params);
      const update = asRecord(params.update);
      this.updates.push(update);
      await this.#onUpdate?.(update);
      return;
    }

    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const request = asRecord(message.params) as PermissionRequest;
      try {
        const outcome = (await this.#onPermission?.(request)) ?? defaultPermission(request);
        this.permissions.push({ request, outcome });
        this.rpc.respond(message.id, { outcome });
      } catch (error) {
        this.rpc.respondError(message.id, -32000, (error as Error).message);
      }
      return;
    }

    if (message.id !== undefined) {
      this.rpc.respondError(message.id, -32601, `Unsupported ACP client method: ${message.method}`);
      return;
    }

    const notification = {
      sessionUpdate: 'ext_notification',
      method: message.method,
      params: (message.params ?? null) as JsonValue,
    };
    this.updates.push(notification);
    await this.#onUpdate?.(notification);
  }
}

export async function runSession(options: RunSessionOptions): Promise<SessionResult> {
  const client = new AcpClient(options.adapter, options);
  let sessionId = '';
  let abortListener: (() => void) | undefined;
  try {
    const initialize = await client.initialize();
    const newSession = await client.newSession({ cwd: options.cwd, mcpServers: options.mcpServers, sessionMeta: options.sessionMeta });
    sessionId = String(newSession.sessionId ?? '');
    if (!sessionId) throw new Error('ACP session/new did not return sessionId');

    if (options.signal) {
      abortListener = () => client.cancel(sessionId);
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const prompt = await client.prompt(sessionId, options.prompt);
    return {
      sessionId,
      initialize,
      newSession,
      prompt,
      updates: [...client.updates],
      permissions: [...client.permissions],
      stderr: client.rpc.stderr,
    };
  } finally {
    if (abortListener) options.signal?.removeEventListener('abort', abortListener);
    client.close();
    if (!client.rpc.child.killed) await Promise.race([once(client.rpc.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}
