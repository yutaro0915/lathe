import type { ClientSideConnection } from '@agentclientprotocol/sdk';

export type SdkPresenceCheck = typeof ClientSideConnection;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type AdapterCommand = {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
};

export type EnvVariable = {
  name: string;
  value: string;
};

export type McpServer =
  | {
      type?: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: EnvVariable[];
    }
  | {
      type: 'http';
      name: string;
      url: string;
      headers: EnvVariable[];
    }
  | {
      type: 'sse';
      name: string;
      url: string;
      headers: EnvVariable[];
    };

export type ContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | JsonRecord;

export type SessionUpdate = JsonRecord;

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
};

export type PermissionRequest = {
  sessionId: string;
  options: PermissionOption[];
  toolCall: JsonRecord;
};

export type PermissionOutcome =
  | {
      outcome: 'selected';
      optionId: string;
    }
  | {
      outcome: 'cancelled';
    };

export type RunSessionOptions = {
  adapter: AdapterCommand;
  mcpServers: McpServer[];
  cwd: string;
  sessionMeta?: JsonRecord;
  prompt: string | ContentBlock[];
  onUpdate?: (update: SessionUpdate) => void | Promise<void>;
  onPermission?: (request: PermissionRequest) => PermissionOutcome | Promise<PermissionOutcome>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SessionResult = {
  sessionId: string;
  initialize: JsonRecord;
  newSession: JsonRecord;
  prompt: JsonRecord;
  updates: SessionUpdate[];
  permissions: Array<{
    request: PermissionRequest;
    outcome: PermissionOutcome;
  }>;
  stderr: string;
};
