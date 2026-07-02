import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { costForUsage } from '../../../lib/cost';
import { filterOrphanHunks, parseCodexSessionRecords } from './codex';
import {
  clampLines,
  hhmmss,
  isCommit,
  isTest,
  langOf,
  lineCount,
  parseJsonlRecords,
  preview,
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

function codexExecCommandEventType(command: string): string {
  if (isCommit(command)) return 'commit';
  if (isTest(command)) return 'test';
  if (/^\s*(cat|sed -n|head|tail|bat|less)\b/.test(command)) return 'file_read';
  return 'bash';
}

test('parseCodexSessionRecords builds a session from synthetic rollout records without fs mocks', () => {
  const raw = jsonl(
    'malformed-json',
    {
      type: 'session_meta',
      timestamp: '2026-06-23T00:00:00+09:00',
      payload: {
        id: 'codex-test',
        cwd: '/repo/project',
        model: 'gpt-5.4',
        git: { branch: 'loop/ds-replacement' },
        cli_version: '1.2.3',
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-23T00:00:00+09:00',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } },
      },
    },
    { type: 'event_msg', timestamp: '2026-06-23T00:00:01+09:00', payload: { type: 'user_message', message: 'Start work' } },
    { type: 'response_item', timestamp: '2026-06-23T00:00:02+09:00', payload: { type: 'reasoning', summary: [{ text: 'Plan briefly' }] } },
    { type: 'event_msg', timestamp: '2026-06-23T00:00:03+09:00', payload: { type: 'agent_message', message: 'Working' } },
    {
      type: 'response_item',
      timestamp: '2026-06-23T00:00:04+09:00',
      payload: { type: 'function_call', call_id: 'read-1', name: 'exec_command', arguments: JSON.stringify({ cmd: "sed -n '1,10p' src/app.ts" }) },
    },
    { type: 'response_item', timestamp: '2026-06-23T00:00:05+09:00', payload: { type: 'function_call_output', call_id: 'read-1', output: 'exited with code 0\nOutput:\nconst x = 1;' } },
    {
      type: 'response_item',
      timestamp: '2026-06-23T00:00:06+09:00',
      payload: { type: 'function_call', call_id: 'commit-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git commit -m "x"' }) },
    },
    { type: 'response_item', timestamp: '2026-06-23T00:00:07+09:00', payload: { type: 'function_call_output', call_id: 'commit-1', output: 'exited with code 0\nOutput:\n[main abcdef1] x' } },
    { type: 'response_item', timestamp: '2026-06-23T00:00:08+09:00', payload: { type: 'custom_tool_call', call_id: 'patch-1', name: 'apply_patch' } },
    { type: 'event_msg', timestamp: '2026-06-23T00:00:09+09:00', payload: { type: 'patch_apply_end', call_id: 'patch-1', changes: { 'src/new.ts': { type: 'add', content: 'one\ntwo\n' } } } },
    { type: 'event_msg', timestamp: '2026-06-23T00:00:10+09:00', payload: { type: 'unsupported_event', message: 'ignored' } },
    { type: 'response_item', timestamp: '2026-06-23T00:00:11+09:00' },
  );

  const built = parseCodexSessionRecords(
    parseJsonlRecords(raw),
    '/tmp/rollout-codex-test.jsonl',
    new Map([['codex-test', 'Synthetic Codex']]),
    opts,
    project,
  );
  assert.ok(built);
  assert.deepEqual(built.events.map((e) => e.type), [
    'user_message',
    'thinking',
    'assistant_message',
    'file_read',
    'commit',
    'file_write',
  ]);
  assert.deepEqual(built.events.map((e) => e.ts), [
    '15:00:01',
    '15:00:02',
    '15:00:03',
    '15:00:04',
    '15:00:06',
    '15:00:08',
  ]);
  assert.equal(built.session.title, 'Synthetic Codex');
  assert.equal(built.session.turn_count, 1);
  assert.equal(built.session.tool_count, 3);
  assert.equal(built.session.edit_count, 1);
  assert.equal(built.session.token_in, 600);
  assert.equal(built.session.token_out, 50);
  assert.equal(built.session.token_usage, 650);
  assert.equal(built.session.cost_usd, costForUsage('gpt-5.4', {
    input: 600,
    output: 50,
    cacheWrite: 0,
    cacheRead: 400,
  }));
  assert.deepEqual(built.eventFiles.map((f) => [f.role, f.path]), [
    ['read', '/repo/project/src/app.ts'],
    ['write', 'src/new.ts'],
  ]);
  assert.equal(built.changedFiles[0]?.language, 'typescript');
  assert.equal(built.changedFiles[0]?.additions, 2);
  assert.equal(built.hunks[0]?.content, '+one\n+two');
  assert.equal(built.attributions[0]?.event_id, built.events.find((e) => e.type === 'file_write')?.id);
  assert.equal(built.sessionCommits[0]?.sha, 'abcdef1');
  assert.equal(parseCodexSessionRecords([], '/tmp/empty.jsonl', new Map(), opts, project), null);
  assert.equal(parseCodexSessionRecords(parseJsonlRecords(jsonl({ type: 'event_msg', payload: { type: 'user_message', message: 'missing meta' } })), '/tmp/no-meta.jsonl', new Map(), opts, project), null);
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

test('Codex session duration preserves values above the PostgreSQL int4 range', () => {
  const raw = jsonl(
    {
      type: 'session_meta',
      timestamp: '2026-05-07T05:57:02.275Z',
      payload: {
        id: 'codex-long-duration',
        cwd: '/repo/project',
        model: 'gpt-5.4',
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-06-05T05:09:11.744Z',
      payload: { type: 'user_message', message: 'Still working' },
    },
  );

  const built = parseCodexSessionRecords(
    parseJsonlRecords(raw),
    '/tmp/rollout-codex-long-duration.jsonl',
    new Map(),
    opts,
    project,
  );

  assert.ok(built);
  assert.equal(built.session.duration_ms, 2_502_729_469);
  assert.ok((built.session.duration_ms ?? 0) > 2_147_483_647);
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
    { input: '2026-06-23T12:34:56.000Z', expected: '12:34:56' },
    { input: '2026-06-23T12:34:56.000+09:00', expected: '03:34:56' },
    { input: '2026-06-23 12:34:56', expected: '12:34:56' },
    { input: 'not-a-date', expected: '' },
    { input: undefined, expected: '' },
  ];

  for (const c of cases) {
    assert.equal(hhmmss(c.input), c.expected, String(c.input));
  }
});

test('filterOrphanHunks drops hunks whose file_id is not in changedFiles, keeps valid ones', () => {
  const changedFiles = [
    { id: 'chf_s1_1', session_id: 's1', path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, language: 'typescript', seq: 1 },
    { id: 'chf_s1_2', session_id: 's1', path: 'b.ts', status: 'added' as const, additions: 5, deletions: 0, language: 'typescript', seq: 2 },
  ];
  const hunks = [
    { id: 'chf_s1_1_h1', file_id: 'chf_s1_1', seq: 1, header: '@@ Update a.ts (+1) @@', content: '+x' },
    { id: 'chf_s1_2_h1', file_id: 'chf_s1_2', seq: 1, header: '@@ Add b.ts (+5) @@', content: '+y' },
    // orphan: file_id refers to a file that was dropped by maxFiles cap
    { id: 'chf_s1_3_h1', file_id: 'chf_s1_3', seq: 1, header: '@@ Add c.ts (+2) @@', content: '+z' },
  ];

  const result = filterOrphanHunks(hunks, changedFiles);
  assert.equal(result.length, 2, 'orphan hunk should be dropped');
  assert.deepEqual(result.map((h) => h.id), ['chf_s1_1_h1', 'chf_s1_2_h1']);
});

test('filterOrphanHunks returns empty array when changedFiles is empty', () => {
  const hunks = [
    { id: 'chf_s1_1_h1', file_id: 'chf_s1_1', seq: 1, header: '@@ Update a.ts (+1) @@', content: '+x' },
  ];
  assert.deepEqual(filterOrphanHunks(hunks, []), []);
});

test('filterOrphanHunks returns all hunks when none are orphans', () => {
  const changedFiles = [
    { id: 'chf_s1_1', session_id: 's1', path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, language: 'typescript', seq: 1 },
  ];
  const hunks = [
    { id: 'chf_s1_1_h1', file_id: 'chf_s1_1', seq: 1, header: '@@ Update a.ts (+1) @@', content: '+x' },
    { id: 'chf_s1_1_h2', file_id: 'chf_s1_1', seq: 2, header: '@@ Update a.ts (+2) @@', content: '+y' },
  ];
  const result = filterOrphanHunks(hunks, changedFiles);
  assert.equal(result.length, 2);
});

test('parseCodexSessionRecords drops orphan hunks when maxFiles cap is applied', () => {
  // Build a session with 3 file edits but maxFiles=2 so the third file is dropped.
  // The hunk for the third file must NOT appear in the returned hunks.
  const makePatch = (callId: string) => ({
    type: 'response_item',
    timestamp: '2026-06-23T00:00:01+09:00',
    payload: { type: 'custom_tool_call', call_id: callId, name: 'apply_patch' },
  });
  const makePatchEnd = (callId: string, fp: string) => ({
    type: 'event_msg',
    timestamp: '2026-06-23T00:00:02+09:00',
    payload: { type: 'patch_apply_end', call_id: callId, changes: { [fp]: { type: 'add', content: 'line\n' } } },
  });
  const raw = [
    { type: 'session_meta', timestamp: '2026-06-23T00:00:00+09:00', payload: { id: 'cap-test', cwd: '/repo', model: 'gpt-5.4' } },
    { type: 'event_msg', timestamp: '2026-06-23T00:00:00+09:00', payload: { type: 'user_message', message: 'go' } },
    makePatch('p1'), makePatchEnd('p1', 'a.ts'),
    makePatch('p2'), makePatchEnd('p2', 'b.ts'),
    makePatch('p3'), makePatchEnd('p3', 'c.ts'),
  ].map((r) => JSON.stringify(r)).join('\n');

  const capOpts: ProviderBuildOptions = { maxEvents: 100, maxFiles: 2, maxHunkLines: 20 };
  const built = parseCodexSessionRecords(
    parseJsonlRecords(raw),
    '/tmp/cap-test.jsonl',
    new Map(),
    capOpts,
    { id: 'local:/repo', displayName: 'repo', gitRemote: null, cwdHint: '/repo' },
  );
  assert.ok(built, 'built should not be null');
  assert.equal(built.changedFiles.length, 2, 'changedFiles should be capped to 2');
  assert.equal(built.hunks.length, 2, 'hunks for the dropped file must be removed');
  // All returned hunks must reference a file that exists in changedFiles
  const fileIds = new Set(built.changedFiles.map((f) => f.id));
  for (const h of built.hunks) {
    assert.ok(fileIds.has(h.file_id), `hunk ${h.id} references missing file_id ${h.file_id}`);
  }
  // attributions must also be clean (no orphan hunk references)
  const hunkIds = new Set(built.hunks.map((h) => h.id));
  for (const a of built.attributions) {
    assert.ok(hunkIds.has(a.hunk_id), `attribution ${a.id} references missing hunk_id ${a.hunk_id}`);
  }
});
