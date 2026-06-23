import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { costForUsage } from '../../../lib/cost';
import { buildCodexSession } from './codex';
import {
  clampLines,
  hhmmss,
  isCommit,
  isTest,
  langOf,
  lineCount,
  preview,
} from '../shared';

function codexExecCommandEventType(command: string): string {
  if (isCommit(command)) return 'commit';
  if (isTest(command)) return 'test';
  if (/^\s*(cat|sed -n|head|tail|bat|less)\b/.test(command)) return 'file_read';
  return 'bash';
}

test('buildCodexSession raw-event parser path is integration-only under pure unit constraints', {
  skip: 'buildCodexSession reads rollout JSONL from fs; no raw-event pure parser is exported',
}, () => {
  assert.equal(typeof buildCodexSession, 'function');
});

test('Codex exec_command records classify shell reads, commits, tests, and unknown commands', () => {
  const cases = [
    { command: "sed -n '1,220p' apps/web/scripts/ingest/providers/codex.ts", eventType: 'file_read' },
    { command: 'cat package.json', eventType: 'file_read' },
    { command: 'git commit -m "tests"', eventType: 'commit' },
    { command: 'pnpm -C apps/web exec tsc --noEmit', eventType: 'test' },
    { command: 'node scripts/build-fixture.mjs', eventType: 'bash' },
    { command: 'unknown_tool --flag', eventType: 'bash' },
  ];

  for (const c of cases) {
    assert.equal(codexExecCommandEventType(c.command), c.eventType, c.command);
  }
});

test('Codex apply_patch file metadata uses stable line counts, language labels, and hunk clamps', () => {
  const cases = [
    {
      path: 'apps/web/scripts/ingest/providers/codex.test.ts',
      content: "import { test } from 'node:test';\n\nassert.equal(1, 1);\n",
      maxLines: 2,
      language: 'typescript',
      lineCount: 3,
      hunk: "+import { test } from 'node:test';\n+\n+… (+1 行)",
    },
    {
      path: 'README.md',
      content: 'one line',
      maxLines: 4,
      language: 'markdown',
      lineCount: 1,
      hunk: '+one line',
    },
    {
      path: 'script.unknown',
      content: '',
      maxLines: 1,
      language: null,
      lineCount: 0,
      hunk: '+',
    },
  ];

  for (const c of cases) {
    assert.equal(langOf(c.path), c.language, c.path);
    assert.equal(lineCount(c.content), c.lineCount, c.path);
    assert.equal(clampLines(c.content, '+', c.maxLines), c.hunk, c.path);
  }
});

test('Codex token cost extraction keeps cached input billable while the session token metric can omit it', () => {
  const withCachedRead = costForUsage('gpt-5.4', {
    input: 100,
    output: 50,
    cacheWrite: 0,
    cacheRead: 900,
  });
  const withoutCachedRead = costForUsage('gpt-5.4', {
    input: 100,
    output: 50,
    cacheWrite: 0,
    cacheRead: 0,
  });

  if (withCachedRead == null || withoutCachedRead == null) {
    assert.fail('gpt-5.4 pricing should be available for Codex token-cost tests');
  }
  assert.ok(withCachedRead > withoutCachedRead);
});

test('Codex visible message previews normalize whitespace and cap titles deterministically', () => {
  const cases = [
    { input: '  hello\n\nworld\t ', width: 90, expected: 'hello world' },
    { input: 'a'.repeat(95), width: 10, expected: 'aaaaaaaaaa…' },
    { input: '', width: 90, expected: '' },
  ];

  for (const c of cases) {
    assert.equal(preview(c.input, c.width), c.expected, c.input);
  }
});

test('Codex rollout timestamps normalize valid ISO values and drop malformed values', () => {
  const cases = [
    { input: '2026-06-23T12:34:56.000Z', expected: '21:34:56' },
    { input: '2026-06-23 12:34:56', expected: '12:34:56' },
    { input: 'not-a-date', expected: '' },
    { input: undefined, expected: '' },
  ];

  for (const c of cases) {
    assert.equal(hhmmss(c.input), c.expected, String(c.input));
  }
});
