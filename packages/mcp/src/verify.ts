import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FINDING_BODY_MAX_LENGTH,
  FINDING_EVIDENCE_MAX_ITEMS,
  FINDING_LOCATOR_MAX_LENGTH,
  FINDING_NOTE_MAX_LENGTH,
  FINDING_TITLE_MAX_LENGTH,
  submitFinding,
  type SubmitFindingInput,
} from '../../../apps/web/lib/mcp.js';
import { closePool, getPool } from '../../../apps/web/lib/postgres.js';

type JsonRecord = Record<string, any>;

const TOOL_NAMES = [
  'list_sessions',
  'get_session_bundle',
  'query_findings',
  'get_evidence_context',
  'submit_finding',
];

function fail(message: string): never {
  throw new Error(message);
}

function findRepoRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = stableJson(actual);
  const e = stableJson(expected);
  if (a !== e) fail(`${label} mismatch\nactual=${a}\nexpected=${e}`);
}

function parseToolResult(response: JsonRecord): unknown {
  const result = response.result;
  if (!result) fail(`missing tool result: ${JSON.stringify(response)}`);
  if (result.isError) fail(`tool returned error: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
  const text = result.content?.find((item: JsonRecord) => item?.type === 'text')?.text;
  if (typeof text !== 'string') fail(`tool result has no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function assertToolError(response: JsonRecord, label: string): void {
  if (response.error) return;
  const result = response.result;
  if (result?.isError === true) return;
  fail(`${label} was not rejected: ${JSON.stringify(response)}`);
}

async function assertRejects(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  fail(`${label} was not rejected`);
}

class StdioRpcClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<
    number,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private stderr = '';

  constructor() {
    const root = findRepoRoot();
    const tsx = path.join(root, 'packages', 'mcp', 'node_modules', '.bin', 'tsx');
    const fallbackTsx = path.join(root, 'apps', 'web', 'node_modules', '.bin', 'tsx');
    const command = fs.existsSync(tsx) ? tsx : fallbackTsx;
    if (!fs.existsSync(command)) fail('tsx binary not found; run pnpm install');
    this.child = spawn(command, [path.join(root, 'packages', 'mcp', 'src', 'server.ts')], {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('close', (status) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`MCP server exited with status ${status}; stderr=${this.stderr.trim()}`));
        this.pending.delete(id);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRecord;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(`non-JSON stdout from MCP server: ${line}\nstderr=${this.stderr.trim()}`);
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }

  async initialize(): Promise<JsonRecord> {
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'lathe-mcp-verify', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
    return initialized;
  }

  request(method: string, params?: JsonRecord): Promise<JsonRecord> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<JsonRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr.trim()}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  notify(method: string, params?: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name: string, args: JsonRecord): Promise<JsonRecord> {
    return this.request('tools/call', { name, arguments: args });
  }

  close(): void {
    this.child.kill('SIGTERM');
  }
}

async function withClient<T>(fn: (client: StdioRpcClient) => Promise<T>): Promise<T> {
  const client = new StdioRpcClient();
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    client.close();
  }
}

async function verifyHandshake(): Promise<void> {
  await withClient(async (client) => {
    const response = await client.request('tools/list', {});
    const tools = response.result?.tools;
    if (!Array.isArray(tools)) fail(`tools/list returned no tools: ${JSON.stringify(response)}`);
    const names = tools.map((tool: JsonRecord) => tool.name).sort();
    assertDeepEqual(names, [...TOOL_NAMES].sort(), 'tools/list names');
  });
  console.log('[verify-mcp:1-handshake] GREEN');
}

async function firstSession() {
  const result = await getPool().query<{
    id: string;
    project_id: string;
    title: string;
    runner: string;
    model: string | null;
    cost_usd: number | null;
    harness_version_id: string | null;
  }>(
    `SELECT id,project_id,title,runner,model,cost_usd,harness_version_id
       FROM sessions
      ORDER BY seq ASC, started_at DESC, id ASC
      LIMIT 1`,
  );
  return result.rows[0] ?? fail('no sessions found; run pnpm -F web ingest first');
}

async function firstEvent(sessionId?: string) {
  const result = await getPool().query<{
    id: string;
    session_id: string;
    project_id: string;
    seq: number;
    title: string;
    body: string | null;
    type: string;
  }>(
    `SELECT e.id,e.session_id,s.project_id,e.seq,e.title,e.body,e.type
       FROM transcript_events e
       JOIN sessions s ON s.id = e.session_id
      WHERE ($1::text IS NULL OR e.session_id = $1)
      ORDER BY e.session_id ASC, e.seq ASC, e.id ASC
      LIMIT 1`,
    [sessionId ?? null],
  );
  return result.rows[0] ?? fail(`no transcript events found${sessionId ? ` for ${sessionId}` : ''}`);
}

async function verifyReadTools(): Promise<void> {
  const session = await firstSession();
  const event = await firstEvent(session.id);
  await withClient(async (client) => {
    const listResult = parseToolResult(
      await client.callTool('list_sessions', { filter: { limit: 5, offset: 0 } }),
    ) as JsonRecord[];
    const directList = await getPool().query(
      `SELECT id,project_id,title,runner,model,cost_usd,harness_version_id
         FROM sessions
        ORDER BY seq ASC, started_at DESC, id ASC
        LIMIT 5 OFFSET 0`,
    );
    assertDeepEqual(
      listResult,
      directList.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        runner: row.runner,
        model: row.model,
        costUsd: row.cost_usd,
        harnessVersionId: row.harness_version_id,
      })),
      'list_sessions',
    );

    const bundle = parseToolResult(await client.callTool('get_session_bundle', { session_id: session.id })) as JsonRecord;
    const directEvents = await getPool().query<{ id: string }>(
      'SELECT id FROM transcript_events WHERE session_id = $1 ORDER BY seq ASC, parent_id NULLS FIRST, id ASC',
      [session.id],
    );
    const directFiles = await getPool().query<{ id: string }>(
      'SELECT id FROM changed_files WHERE session_id = $1 ORDER BY seq ASC',
      [session.id],
    );
    const directTypeCounts = await getPool().query<{ type: string; n: number }>(
      `SELECT type, COUNT(*)::int AS n
         FROM transcript_events
        WHERE session_id = $1
          AND parent_id IS NULL
        GROUP BY type`,
      [session.id],
    );
    const typeCounts: Record<string, number> = {};
    for (const row of directTypeCounts.rows) typeCounts[row.type] = row.n;
    assertDeepEqual(bundle.session.id, session.id, 'get_session_bundle session id');
    assertDeepEqual(
      (bundle.events as JsonRecord[]).map((row) => row.id),
      directEvents.rows.map((row) => row.id),
      'get_session_bundle event ids',
    );
    assertDeepEqual(
      (bundle.changedFiles as JsonRecord[]).map((row) => row.id),
      directFiles.rows.map((row) => row.id),
      'get_session_bundle changed file ids',
    );
    assertDeepEqual(bundle.typeCounts, typeCounts, 'get_session_bundle type counts');

    const findings = parseToolResult(await client.callTool('query_findings', { filter: { limit: 10 } })) as JsonRecord[];
    const directFindings = await getPool().query<{ id: number }>(
      'SELECT id FROM findings ORDER BY created_at DESC, id DESC LIMIT 10',
    );
    assertDeepEqual(
      findings.map((row) => row.id),
      directFindings.rows.map((row) => row.id),
      'query_findings ids',
    );

    const context = parseToolResult(
      await client.callTool('get_evidence_context', {
        subject_kind: 'event',
        subject_id: event.id,
      }),
    ) as JsonRecord;
    assertDeepEqual(
      {
        id: context.context.id,
        session_id: context.context.session_id,
        title: context.context.title,
        body: context.context.body,
      },
      { id: event.id, session_id: event.session_id, title: event.title, body: event.body },
      'get_evidence_context event',
    );
  });
  console.log('[verify-mcp:2-read-tools] GREEN');
}

async function verifySubmitFinding(): Promise<void> {
  const event = await firstEvent();
  const analyst = `mcp-verify-${process.pid}-${Date.now()}`;
  const strictAnalyst = `${analyst}-primary`;
  const analysisAnalyst = `${analyst}-analysis`;
  const validFinding = {
    analyst,
    kind: 'failure_loop',
    title: 'MCP verify finding',
    body: 'MCP verify body',
    confidence: 0.75,
    project_id: event.project_id,
    evidence: [
      {
        subject_kind: 'event',
        subject_id: event.id,
        session_id: event.session_id,
        locator: { seq: event.seq },
        note: 'verify evidence',
      },
    ],
  };
  const validLibFinding: SubmitFindingInput = {
    analyst,
    kind: 'failure_loop',
    title: 'MCP verify finding',
    body: 'MCP verify body',
    confidence: 0.75,
    projectId: event.project_id,
    evidence: [
      {
        subjectKind: 'event',
        subjectId: event.id,
        sessionId: event.session_id,
        locator: { seq: event.seq },
        note: 'verify evidence',
      },
    ],
  };

  try {
    await assertRejects(
      () => submitFinding({ ...validLibFinding, title: 't'.repeat(FINDING_TITLE_MAX_LENGTH + 1) }),
      'submitFinding title limit',
    );
    await assertRejects(
      () => submitFinding({ ...validLibFinding, body: 'b'.repeat(FINDING_BODY_MAX_LENGTH + 1) }),
      'submitFinding body limit',
    );
    await assertRejects(
      () =>
        submitFinding({
          ...validLibFinding,
          evidence: [{ ...validLibFinding.evidence[0], note: 'n'.repeat(FINDING_NOTE_MAX_LENGTH + 1) }],
        }),
      'submitFinding note limit',
    );
    await assertRejects(
      () =>
        submitFinding({
          ...validLibFinding,
          evidence: [{ ...validLibFinding.evidence[0], locator: { payload: 'x'.repeat(FINDING_LOCATOR_MAX_LENGTH) } }],
        }),
      'submitFinding locator limit',
    );
    await assertRejects(
      () =>
        submitFinding({
          ...validLibFinding,
          evidence: Array.from({ length: FINDING_EVIDENCE_MAX_ITEMS + 1 }, () => validLibFinding.evidence[0]),
        }),
      'submitFinding evidence count limit',
    );
    const analysisResult = await submitFinding({
      ...validLibFinding,
      analyst: analysisAnalyst,
      title: 'MCP verify non-string analysis normalization',
      analysis: {
        causeHypothesis: 42 as unknown as string,
        agentIntent: 'agent intent survives',
        impact: { nested: true } as unknown as string,
      },
    });
    if (!analysisResult.created) fail(`submitFinding non-string analysis normalization did not create: ${JSON.stringify(analysisResult)}`);

    await withClient(async (client) => {
      assertToolError(
        await client.callTool('submit_finding', {
          finding: { ...validFinding, evidence: [] },
        }),
        'submit_finding without evidence',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: { ...validFinding, kind: 'not_a_kind' },
        }),
        'submit_finding with invalid kind',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: { ...validFinding, title: 't'.repeat(FINDING_TITLE_MAX_LENGTH + 1) },
        }),
        'submit_finding with title over limit',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: { ...validFinding, body: 'b'.repeat(FINDING_BODY_MAX_LENGTH + 1) },
        }),
        'submit_finding with body over limit',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: {
            ...validFinding,
            evidence: [{ ...validFinding.evidence[0], note: 'n'.repeat(FINDING_NOTE_MAX_LENGTH + 1) }],
          },
        }),
        'submit_finding with note over limit',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: {
            ...validFinding,
            evidence: [{ ...validFinding.evidence[0], locator: { payload: 'x'.repeat(FINDING_LOCATOR_MAX_LENGTH) } }],
          },
        }),
        'submit_finding with locator over limit',
      );
      assertToolError(
        await client.callTool('submit_finding', {
          finding: {
            ...validFinding,
            evidence: Array.from({ length: FINDING_EVIDENCE_MAX_ITEMS + 1 }, () => validFinding.evidence[0]),
          },
        }),
        'submit_finding with too many evidence items',
      );

      const first = parseToolResult(await client.callTool('submit_finding', { finding: validFinding })) as JsonRecord;
      const second = parseToolResult(await client.callTool('submit_finding', { finding: validFinding })) as JsonRecord;
      if (first.created !== true) fail(`first submit did not create: ${JSON.stringify(first)}`);
      if (second.created !== false) fail(`second submit was not idempotent: ${JSON.stringify(second)}`);
      if (first.findingId !== second.findingId) fail(`idempotent resend returned different ids: ${first.findingId} ${second.findingId}`);
      const changed = parseToolResult(
        await client.callTool('submit_finding', {
          finding: { ...validFinding, title: 'MCP verify finding changed', body: 'MCP verify body changed' },
        }),
      ) as JsonRecord;
      if (changed.created !== false || changed.findingId !== first.findingId) {
        fail(`changed resend was not idempotent: ${JSON.stringify(changed)}`);
      }
      const changedFields = (changed.idempotencyDiff as JsonRecord | null | undefined)?.changedFields;
      if (!Array.isArray(changedFields) || !changedFields.includes('title') || !changedFields.includes('body')) {
        fail(`changed resend did not report title/body differences: ${JSON.stringify(changed)}`);
      }

      const counts = await getPool().query<{ findings: number; evidence: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM findings WHERE analyst = $1) AS findings,
           (SELECT COUNT(*)::int
              FROM finding_evidence fe
              JOIN findings f ON f.id = fe.finding_id
             WHERE f.analyst = $1) AS evidence`,
        [analyst],
      );
      if (counts.rows[0]?.findings !== 1 || counts.rows[0]?.evidence !== 1) {
        fail(`submit_finding inserted wrong counts: ${JSON.stringify(counts.rows[0])}`);
      }

      const primaryEvidence = {
        ...validFinding.evidence[0],
        locator: { seq: event.seq, role: 'primary' },
        note: 'primary evidence',
      };
      const secondaryEvidence = {
        ...validFinding.evidence[0],
        locator: { seq: event.seq, role: 'secondary' },
        note: 'secondary evidence',
      };
      const strictFirst = parseToolResult(
        await client.callTool('submit_finding', {
          finding: {
            ...validFinding,
            analyst: strictAnalyst,
            title: 'MCP primary evidence finding',
            evidence: [primaryEvidence, secondaryEvidence],
          },
        }),
      ) as JsonRecord;
      const strictSecond = parseToolResult(
        await client.callTool('submit_finding', {
          finding: {
            ...validFinding,
            analyst: strictAnalyst,
            title: 'MCP secondary as primary finding',
            evidence: [secondaryEvidence],
          },
        }),
      ) as JsonRecord;
      if (strictFirst.created !== true || strictSecond.created !== true || strictFirst.findingId === strictSecond.findingId) {
        fail(`primary evidence idempotency was not strict: ${JSON.stringify({ strictFirst, strictSecond })}`);
      }
      const strictCounts = await getPool().query<{ findings: number; evidence: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM findings WHERE analyst = $1) AS findings,
           (SELECT COUNT(*)::int
              FROM finding_evidence fe
              JOIN findings f ON f.id = fe.finding_id
             WHERE f.analyst = $1) AS evidence`,
        [strictAnalyst],
      );
      if (strictCounts.rows[0]?.findings !== 2 || strictCounts.rows[0]?.evidence !== 3) {
        fail(`strict primary evidence inserted wrong counts: ${JSON.stringify(strictCounts.rows[0])}`);
      }
    });
  } finally {
    await getPool().query('DELETE FROM findings WHERE analyst IN ($1, $2, $3)', [analyst, strictAnalyst, analysisAnalyst]);
  }
  console.log('[verify-mcp:3-submit-finding] GREEN');
}

async function verifyPlacement(): Promise<void> {
  const root = findRepoRoot();
  const server = fs.readFileSync(path.join(root, 'packages', 'mcp', 'src', 'server.ts'), 'utf8');
  const logic = fs.readFileSync(path.join(root, 'apps', 'web', 'lib', 'mcp.ts'), 'utf8');
  if (!server.includes("../../../apps/web/lib/mcp.js")) {
    fail('MCP server does not call the apps/web/lib MCP business logic module');
  }
  for (const pattern of [/INSERT\s+INTO/i, /SELECT\s+.+\s+FROM/i, /getPool\s*\(/, /queryRows\s*\(/, /queryOne\s*\(/]) {
    if (pattern.test(server)) fail(`MCP tool handler contains DB logic matching ${pattern}`);
  }
  if (!logic.includes('getSessionBundle')) fail('apps/web/lib/mcp.ts does not reuse getSessionBundle');
  if (!logic.includes('submitFinding')) fail('apps/web/lib/mcp.ts does not expose submitFinding');
  console.log('[verify-mcp:4-placement] GREEN');
}

async function run(command: string | undefined): Promise<void> {
  if (command === 'handshake') return verifyHandshake();
  if (command === 'read') return verifyReadTools();
  if (command === 'submit') return verifySubmitFinding();
  if (command === 'placement') return verifyPlacement();
  if (command === 'all') {
    await verifyHandshake();
    await verifyReadTools();
    await verifySubmitFinding();
    await verifyPlacement();
    return;
  }
  fail('usage: tsx src/verify.ts handshake|read|submit|placement|all');
}

run(process.argv[2])
  .catch((error) => {
    console.error(`[verify-mcp] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
