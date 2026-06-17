import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AdapterCommand, JsonRecord, JsonValue } from './types';

type JsonRpcId = string | number;

type Pending = {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: {
    code?: number;
    message?: string;
    data?: JsonValue;
  };
};

export class StdioJsonRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';

  #nextId = 1;
  #pending = new Map<JsonRpcId, Pending>();
  #stdoutBuffer = '';
  #closed = false;
  #defaultTimeoutMs: number;

  constructor(adapter: AdapterCommand, options: { cwd?: string; timeoutMs?: number } = {}) {
    super();
    this.#defaultTimeoutMs = options.timeoutMs ?? 120_000;
    this.child = spawn(adapter.command, adapter.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...(adapter.env ?? {}) },
      stdio: 'pipe',
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
      this.emit('stderr', chunk);
    });
    this.child.on('error', (error) => this.#failAll(error));
    this.child.on('exit', (code, signal) => {
      this.#closed = true;
      this.#failAll(new Error(`ACP adapter exited before response completion: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.emit('exit', { code, signal });
    });
  }

  request(method: string, params: JsonValue, timeoutMs = this.#defaultTimeoutMs): Promise<JsonRecord> {
    const id = this.#nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(message);
    });
  }

  notify(method: string, params: JsonValue): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  respond(id: JsonRpcId, result: JsonValue): void {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: JsonValue): void {
    const error = data === undefined ? { code, message } : { code, message, data };
    this.#write({ jsonrpc: '2.0', id, error });
  }

  fail(error: Error): void {
    this.#failAll(error);
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed || !this.child.stdin.writable) {
      throw new Error('ACP adapter stdin is closed');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.emit('protocolError', new Error(`Invalid ACP JSON on stdout: ${(error as Error).message}`));
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit('protocolError', new Error(`Unexpected ACP response id: ${String(message.id)}`));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`ACP error ${message.error.code ?? 'unknown'}: ${message.error.message ?? 'unknown error'}`));
      } else {
        pending.resolve((message.result ?? {}) as JsonRecord);
      }
      return;
    }

    if (message.method) {
      this.emit('message', message);
      return;
    }

    this.emit('protocolError', new Error(`Unsupported ACP message: ${line}`));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
