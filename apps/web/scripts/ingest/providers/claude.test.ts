import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { costForUsage } from '../../../lib/cost';
import { parseClaudeSessionRecords } from './claude';
import {
  durationBetween,
  hhmmss,
  isCommit,
  isTest,
  parseJsonlRecords,
  parseSubagentUsage,
  toolTitle,
  toolType,
} from '../shared';
import type { ProviderBuildOptions } from './types';

const opts: ProviderBuildOptions = { maxEvents: 100, maxFiles: 20, maxHunkLines: 20 };
const project = {
  id: 'local:/repo/project',
  displayName: 'project',
  gitRemote: null,
  cwdHint: '/repo/project',
};

function jsonl(...rows: Array<Record<string, unknown> | string>): string {
  return rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
}

function claudeBashEventType(command: string): string {
  if (isCommit(command)) return 'commit';
  if (isTest(command)) return 'test';
  return toolType('Bash');
}

test('parseClaudeSessionRecords builds a session from synthetic JSONL records without fs mocks', () => {
  const raw = jsonl(
    'malformed-json',
    {
      type: 'user',
      timestamp: '2026-06-23T00:00:02+09:00',
      sessionId: 'claude-test',
      gitBranch: 'loop/ds-replacement',
      cwd: '/repo/project',
      version: '1.0.0',
      message: { content: 'Please inspect the parser' },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-23T00:00:04+09:00',
      message: {
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 50,
        },
        content: [
          { type: 'thinking', thinking: 'Need to inspect records' },
          { type: 'text', text: 'I will read and test.' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/project/app.ts' } },
          { type: 'tool_use', id: 'test-1', name: 'Bash', input: { command: 'pnpm test' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-06-23T00:00:06+09:00',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read-1', content: 'const x = 1;', is_error: false },
          { type: 'tool_result', tool_use_id: 'test-1', content: 'ok', is_error: false },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/repo/project/new.ts', content: 'a\nb\n' } },
        ],
      },
    },
    {
      type: 'attachment',
      timestamp: '2026-06-23T00:00:08+09:00',
      attachment: {
        type: 'nested_memory',
        path: '/repo/project/AGENTS.md',
        displayPath: 'AGENTS.md',
        content: { type: 'project', content: 'rules' },
      },
    },
    { type: 'unknown-event', timestamp: '2026-06-23T00:00:09+09:00', payload: { ignored: true } },
  );

  const built = parseClaudeSessionRecords(parseJsonlRecords(raw), '/tmp/claude-test.jsonl', opts, project);
  assert.ok(built);
  assert.deepEqual(built.events.map((e) => e.type), [
    'user_message',
    'thinking',
    'assistant_message',
    'file_read',
    'test',
    'file_write',
    'memory',
  ]);
  assert.deepEqual(built.events.map((e) => e.ts), [
    '15:00:02',
    '15:00:04',
    '15:00:04',
    '15:00:04',
    '15:00:04',
    '',
    '15:00:08',
  ]);
  assert.equal(built.session.id, 'claude-test');
  assert.equal(built.session.turn_count, 1);
  assert.equal(built.session.tool_count, 3);
  assert.equal(built.session.edit_count, 1);
  assert.equal(built.session.token_in, 110);
  assert.equal(built.session.token_out, 20);
  assert.equal(built.session.token_usage, 130);
  assert.equal(built.session.cost_usd, costForUsage('claude-sonnet-4', {
    input: 100,
    output: 20,
    cacheWrite: 10,
    cacheRead: 50,
  }));
  assert.deepEqual(built.eventFiles.map((f) => [f.role, f.path]), [
    ['read', '/repo/project/app.ts'],
    ['write', '/repo/project/new.ts'],
  ]);
  assert.equal(built.changedFiles[0]?.additions, 2);
  assert.equal(built.hunks[0]?.content, '+a\n+b');
  assert.equal(built.attributions[0]?.event_id, built.events.find((e) => e.type === 'file_write')?.id);
  assert.equal(parseClaudeSessionRecords(parseJsonlRecords(''), '/tmp/empty.jsonl', opts, project), null);
  assert.equal(parseClaudeSessionRecords(parseJsonlRecords('not-json'), '/tmp/bad.jsonl', opts, project), null);
});

test('Claude tool_use records map provider tool names to structured event types and titles', () => {
  const cases = [
    {
      name: 'Read',
      input: { file_path: '/repo/app.ts' },
      eventType: 'file_read',
      title: 'File read · /repo/app.ts',
    },
    {
      name: 'Write',
      input: { file_path: '/repo/new.ts' },
      eventType: 'file_write',
      title: 'File write · /repo/new.ts',
    },
    {
      name: 'Edit',
      input: { file_path: '/repo/app.ts' },
      eventType: 'file_edit',
      title: 'File edit · /repo/app.ts',
    },
    {
      name: 'MultiEdit',
      input: { file_path: '/repo/app.ts' },
      eventType: 'file_edit',
      title: 'File edit · /repo/app.ts',
    },
    {
      name: 'Task',
      input: { subagent_type: 'explorer' },
      eventType: 'subagent',
      title: 'Sub-agent · explorer',
    },
    {
      name: 'Skill',
      input: { name: 'openai-docs' },
      eventType: 'skill',
      title: 'Skill · openai-docs',
    },
    {
      name: 'UnknownTool',
      input: {},
      eventType: 'bash',
      title: 'UnknownTool',
    },
  ];

  for (const c of cases) {
    assert.equal(toolType(c.name), c.eventType, c.name);
    assert.equal(toolTitle(c.name, c.input), c.title, c.name);
  }
});

test('Claude Bash tool events refine commit and test commands before falling back to bash', () => {
  const cases = [
    { command: 'git commit -m "add parser tests"', eventType: 'commit' },
    { command: 'pnpm test', eventType: 'test' },
    { command: 'pnpm run test -- --watch=false', eventType: 'test' },
    { command: 'tsc --noEmit', eventType: 'test' },
    { command: 'pnpm install --frozen-lockfile', eventType: 'bash' },
  ];

  for (const c of cases) {
    assert.equal(claudeBashEventType(c.command), c.eventType, c.command);
  }
});

test('Claude subagent result footer extracts duration, tokens, and tool-use counts', () => {
  const cases = [
    {
      text: 'done\nsubagent_tokens: 12003\ntool_uses: 7\nduration_ms: 45678',
      expected: { tokens: 12003, toolUses: 7, durationMs: 45678 },
    },
    {
      text: 'duration_ms: 0\nsubagent_tokens: 0\ntool_uses: 0',
      expected: { tokens: 0, toolUses: 0, durationMs: 0 },
    },
    {
      text: 'subagent finished without usage footer',
      expected: { tokens: null, toolUses: null, durationMs: null },
    },
  ];

  for (const c of cases) {
    assert.deepEqual(parseSubagentUsage(c.text), c.expected, c.text);
  }
});

test('Claude timestamp and tool-result duration derivation tolerates malformed or missing fields', () => {
  const cases = [
    {
      startedAt: '2026-06-23T12:34:56.000Z',
      endedAt: '2026-06-23T12:35:01.500Z',
      ts: '12:34:56',
      durationMs: 5500,
    },
    {
      startedAt: '2026-06-23T12:34:56.000+09:00',
      endedAt: '2026-06-23T12:35:01.500+09:00',
      ts: '03:34:56',
      durationMs: 5500,
    },
    {
      startedAt: '2026-06-23T12:35:01.500Z',
      endedAt: '2026-06-23T12:34:56.000Z',
      ts: '12:35:01',
      durationMs: 0,
    },
    {
      startedAt: 'not-a-date',
      endedAt: '2026-06-23T12:34:56.000Z',
      ts: '',
      durationMs: null,
    },
    {
      startedAt: undefined,
      endedAt: '2026-06-23T12:34:56.000Z',
      ts: '',
      durationMs: null,
    },
  ];

  for (const c of cases) {
    assert.equal(hhmmss(c.startedAt), c.ts, String(c.startedAt));
    assert.equal(durationBetween(c.startedAt, c.endedAt), c.durationMs, String(c.startedAt));
  }
});
