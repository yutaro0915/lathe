import { z, type ZodTypeAny } from 'zod';
import type { ToolCall, ToolDefinition } from './types.js';

export interface ToolExecutionContext<Deps = unknown> {
  deps: Deps;
  signal?: AbortSignal;
}

export interface Tool<Deps = unknown> extends ToolDefinition {
  execute(input: unknown, ctx: ToolExecutionContext<Deps>): Promise<unknown>;
}

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolClientLike {
  callTool(name: string, input: unknown): Promise<unknown>;
}

export class ToolRegistry<Deps = unknown> {
  private readonly tools = new Map<string, Tool<Deps>>();

  constructor(tools: Tool<Deps>[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool<Deps>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerMany(tools: Tool<Deps>[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool<Deps> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<Deps>[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async executeTool(call: ToolCall, ctx: ToolExecutionContext<Deps>): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error(`unknown tool: ${call.name}`);
    const input = tool.inputSchema.parse(call.input);
    return tool.execute(input, ctx);
  }
}

export function defineTool<Deps = unknown>(tool: Tool<Deps>): Tool<Deps> {
  return tool;
}

export function mcpToolToTool<Deps = unknown>(mcpTool: McpToolLike, client: McpToolClientLike): Tool<Deps> {
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
    execute: async (input) => client.callTool(mcpTool.name, input),
  };
}

export function mcpToolsToRegistry<Deps = unknown>(mcpTools: McpToolLike[], client: McpToolClientLike): ToolRegistry<Deps> {
  return new ToolRegistry(mcpTools.map((tool) => mcpToolToTool(tool, client)));
}

export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  const record = objectValue(schema);
  if (!record) return z.unknown();
  if (Array.isArray(record.enum)) {
    const values = record.enum.filter((value): value is string => typeof value === 'string');
    if (values.length > 0) return z.enum(values as [string, ...string[]]);
  }
  const type = Array.isArray(record.type) ? record.type.find((item) => item !== 'null') : record.type;
  if (type === 'object' || record.properties) {
    const props = objectValue(record.properties) ?? {};
    const required = new Set(Array.isArray(record.required) ? record.required.filter((item): item is string => typeof item === 'string') : []);
    const shape: Record<string, ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      const prop = jsonSchemaToZod(propSchema);
      shape[key] = required.has(key) ? prop : prop.optional();
    }
    const objectSchema = z.object(shape);
    return record.additionalProperties === true ? objectSchema.catchall(z.unknown()) : objectSchema;
  }
  if (type === 'array') return z.array(jsonSchemaToZod(record.items));
  if (type === 'string') return z.string();
  if (type === 'integer') return z.number().int();
  if (type === 'number') return z.number();
  if (type === 'boolean') return z.boolean();
  return z.unknown();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
