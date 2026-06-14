import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from './tool.js';
import { mcpToolToTool, type McpToolLike } from './tool.js';

export type McpTransportConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export interface McpClientConfig {
  name?: string;
  version?: string;
  transport: McpTransportConfig;
}

type SdkClient = InstanceType<typeof Client>;

export class NeutralMcpClient {
  private readonly client: SdkClient;
  private connected = false;

  constructor(private readonly config: McpClientConfig) {
    this.client = new Client({
      name: config.name ?? 'lathe-agent',
      version: config.version ?? '0.0.0',
    });
  }

  async connect(): Promise<this> {
    if (this.connected) return this;
    if (this.config.transport.type !== 'stdio') {
      throw new Error(`${this.config.transport.type} MCP transport is declared but not implemented yet`);
    }
    await this.client.connect(
      new StdioClientTransport({
        command: this.config.transport.command,
        args: this.config.transport.args ?? [],
        cwd: this.config.transport.cwd,
        env: this.config.transport.env,
      }),
    );
    this.connected = true;
    return this;
  }

  async listTools(): Promise<McpToolLike[]> {
    await this.connect();
    const response = await this.client.listTools();
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    await this.connect();
    const response = await this.client.callTool({ name, arguments: objectValue(input) ?? {} });
    assertSuccessfulToolResult(name, response);
    return unpackToolResult(response);
  }

  async tools<Deps = unknown>(): Promise<Tool<Deps>[]> {
    const tools = await this.listTools();
    return tools.map((tool) => mcpToolToTool<Deps>(tool, this));
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}

function assertSuccessfulToolResult(name: string, response: unknown): asserts response is CallToolResult {
  const record = objectValue(response);
  const protocolError = objectValue(record?.error);
  if (protocolError) {
    throw new Error(mcpProtocolErrorMessage(protocolError));
  }
  if (record?.isError === true) {
    throw new Error(mcpToolErrorMessage(name, record));
  }
}

function unpackToolResult(response: unknown): unknown {
  const record = objectValue(response);
  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (content?.length === 1) {
    const item = objectValue(content[0]);
    if (item?.type === 'text' && typeof item.text === 'string') {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
  }
  return response;
}

function mcpToolErrorMessage(name: string, record: Record<string, unknown>): string {
  const contentText = contentBlocksText(record.content);
  if (contentText) return contentText;
  const structured = objectValue(record.structuredContent);
  if (structured) return JSON.stringify(structured);
  return `MCP tool ${name} returned an error`;
}

function mcpProtocolErrorMessage(error: Record<string, unknown>): string {
  const message = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : 'MCP protocol error';
  const code = typeof error.code === 'number' ? `MCP protocol error ${error.code}: ` : '';
  return `${code}${message}`;
}

function contentBlocksText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const block = objectValue(item);
      if (!block) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join('\n');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
