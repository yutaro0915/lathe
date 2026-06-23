import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildClaudeSession } from './claude';
import {
  durationBetween,
  hhmmss,
  isCommit,
  isTest,
  parseSubagentUsage,
  toolTitle,
  toolType,
} from '../shared';

function claudeBashEventType(command: string): string {
  if (isCommit(command)) return 'commit';
  if (isTest(command)) return 'test';
  return toolType('Bash');
}

test('buildClaudeSession raw-event parser path is integration-only under pure unit constraints', {
  skip: 'buildClaudeSession reads JSONL and optional subagent files from fs; no raw-event pure parser is exported',
}, () => {
  assert.equal(typeof buildClaudeSession, 'function');
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
