import * as os from 'node:os';
import * as path from 'node:path';
import {
  latheMcpServer,
  runSession,
  type AdapterCommand,
  type McpServer,
  type PermissionOutcome,
  type PermissionRequest,
  type SessionResult,
  type SessionUpdate,
} from '@lathe/acp-client';

export type LathePermissionPolicy = 'chat-readonly' | 'analyst-submit';

export interface RunLatheAgentSessionInput {
  prompt: string;
  adapterEnvPrefix: 'LATHE_CHAT_ACP' | 'LATHE_ANALYST_ACP';
  adapterEnv?: Record<string, string | undefined>;
  mcpEnv?: Record<string, string>;
  permissionPolicy: LathePermissionPolicy;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (update: SessionUpdate) => void | Promise<void>;
}

const READ_ONLY_LATHE_TOOLS = new Set([
  'mcp__lathe__list_sessions',
  'mcp__lathe__get_session_bundle',
  'mcp__lathe__query_findings',
  'mcp__lathe__get_evidence_context',
  'list_sessions',
  'get_session_bundle',
  'query_findings',
  'get_evidence_context',
]);

const SUBMIT_FINDING_TOOLS = new Set([
  'mcp__lathe__submit_finding',
  'submit_finding',
]);

export function repoRoot(): string {
  return path.resolve(process.cwd(), '..', '..');
}

export async function runLatheAgentSession(input: RunLatheAgentSessionInput): Promise<SessionResult> {
  return runSession({
    adapter: latheAcpAdapter({
      envPrefix: input.adapterEnvPrefix,
      extraEnv: input.adapterEnv,
    }),
    cwd: repoRoot(),
    mcpServers: latheAgentMcpServers(input.mcpEnv ?? {}),
    sessionMeta: {
      claudeCode: {
        emitRawSDKMessages: true,
        options: { settingSources: ['user'] },
      },
    },
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onUpdate: input.onUpdate,
    onPermission: (request) => allowLathePermission(input.permissionPolicy, request),
  });
}

function latheAcpAdapter(options: {
  envPrefix: RunLatheAgentSessionInput['adapterEnvPrefix'];
  extraEnv?: Record<string, string | undefined>;
}): AdapterCommand {
  const raw = process.env[`${options.envPrefix}_ADAPTER`];
  const adapter = rawAdapter(raw) ?? envAdapter(options.envPrefix);
  return withLatheConfigDir({
    ...adapter,
    env: { ...(adapter.env ?? {}), ...(options.extraEnv ?? {}) },
  });
}

function rawAdapter(raw: string | undefined): AdapterCommand | undefined {
  if (raw === 'fake') {
    return {
      command: process.execPath,
      args: [path.resolve(repoRoot(), 'packages/acp-client/test/fixtures/fake-acp-agent.mjs')],
    };
  }
  if (raw?.trim().startsWith('{')) return JSON.parse(raw) as AdapterCommand;
  if (raw?.trim()) return { command: process.execPath, args: [raw.trim()] };
  return undefined;
}

function envAdapter(envPrefix: RunLatheAgentSessionInput['adapterEnvPrefix']): AdapterCommand {
  const command = process.env[`${envPrefix}_COMMAND`] || 'npx';
  const args = process.env[`${envPrefix}_ARGS`]
    ? JSON.parse(process.env[`${envPrefix}_ARGS`] ?? '[]') as string[]
    : ['-y', '@agentclientprotocol/claude-agent-acp@latest'];
  return { command, args };
}

function withLatheConfigDir(adapter: AdapterCommand): AdapterCommand {
  return {
    ...adapter,
    env: {
      ...(adapter.env ?? {}),
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.lathe'),
    },
  };
}

function latheAgentMcpServers(envFlags: Record<string, string>): McpServer[] {
  const server = latheMcpServer({ repoRoot: repoRoot(), databaseUrl: process.env.DATABASE_URL });
  if ('env' in server) {
    server.env = [
      ...server.env,
      ...Object.entries(envFlags).map(([name, value]) => ({ name, value })),
    ];
  }
  return [server];
}

export function permissionToolName(request: PermissionRequest): string {
  const toolCall = request.toolCall as Record<string, unknown> | undefined;
  const meta = toolCall?._meta;
  const metaTool = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).toolName
    : undefined;
  const raw = [toolCall?.name, toolCall?.toolName, metaTool, toolCall?.title]
    .find((item) => typeof item === 'string');
  return typeof raw === 'string' ? raw : '';
}

export function allowLathePermission(
  policy: LathePermissionPolicy,
  request: PermissionRequest,
): PermissionOutcome {
  const toolName = permissionToolName(request);
  const allow = policy === 'chat-readonly'
    ? READ_ONLY_LATHE_TOOLS.has(toolName)
    : SUBMIT_FINDING_TOOLS.has(toolName);
  return selectPermission(request, allow);
}

function selectPermission(request: PermissionRequest, allow: boolean): PermissionOutcome {
  const kinds = allow
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  const option = request.options.find((item) => kinds.includes(item.kind));
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}
