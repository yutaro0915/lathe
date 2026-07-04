import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SubmitFindingInput } from '@lathe/domain';
import {
  clampLimit,
  eventText,
  findingKey,
  makeFinding,
  primarySessionId,
  sessionEvidence,
  shorten,
  turnEvidence,
  type EventRow,
} from './common';

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

test('clampLimit returns DEFAULT_LIMIT (20) for non-finite inputs', () => {
  const cases: Array<{ name: string; input: number | undefined }> = [
    { name: 'undefined', input: undefined },
    { name: 'NaN', input: Number.NaN },
    { name: 'Infinity', input: Infinity },
    { name: '-Infinity', input: -Infinity },
  ];

  for (const { name, input } of cases) {
    assert.strictEqual(clampLimit(input), 20, name);
  }
});

test('clampLimit clamps to [1, MAX_LIMIT(20)]', () => {
  const cases: Array<{ name: string; input: number; expected: number }> = [
    { name: '0 → 1 (min clamp)', input: 0, expected: 1 },
    { name: 'negative → 1', input: -5, expected: 1 },
    { name: '999 → 20 (MAX_LIMIT)', input: 999, expected: 20 },
    { name: 'within range', input: 10, expected: 10 },
    { name: 'exactly MAX_LIMIT', input: 20, expected: 20 },
  ];

  for (const { name, input, expected } of cases) {
    assert.strictEqual(clampLimit(input), expected, name);
  }
});

// ---------------------------------------------------------------------------
// shorten
// ---------------------------------------------------------------------------

test('shorten compresses internal whitespace', () => {
  assert.strictEqual(shorten('hello   world', 100), 'hello world');
  assert.strictEqual(shorten('  leading and trailing  ', 100), 'leading and trailing');
  assert.strictEqual(shorten('a\t\nb', 100), 'a b');
});

test('shorten truncates to max length with trailing ellipsis', () => {
  const result = shorten('hello world', 5);
  assert.strictEqual(result.length, 5, 'truncated length must equal max');
  assert.ok(result.endsWith('…'), 'truncated string must end with ellipsis');
  assert.strictEqual(result, 'hell…');
});

test('shorten does not truncate when compact length equals max', () => {
  assert.strictEqual(shorten('hello', 5), 'hello');
});

// ---------------------------------------------------------------------------
// primarySessionId
// ---------------------------------------------------------------------------

test('primarySessionId returns sessionId when present', () => {
  const finding: SubmitFindingInput = {
    analyst: 'rules-v1',
    kind: 'failure_loop',
    title: 'test',
    body: 'body',
    confidence: 0.5,
    evidence: [{ subjectKind: 'turn', sessionId: 'session-abc', locator: { seq: 1 } }],
  };
  assert.strictEqual(primarySessionId(finding), 'session-abc');
});

test('primarySessionId falls back to subjectId for session subjectKind', () => {
  const finding: SubmitFindingInput = {
    analyst: 'rules-v1',
    kind: 'failure_loop',
    title: 'test',
    body: 'body',
    confidence: 0.5,
    evidence: [{ subjectKind: 'session', subjectId: 'session-xyz' }],
  };
  assert.strictEqual(primarySessionId(finding), 'session-xyz');
});

test('primarySessionId returns undefined for non-session evidence without sessionId', () => {
  const finding: SubmitFindingInput = {
    analyst: 'rules-v1',
    kind: 'failure_loop',
    title: 'test',
    body: 'body',
    confidence: 0.5,
    evidence: [{ subjectKind: 'event', subjectId: 'event-1' }],
  };
  assert.strictEqual(primarySessionId(finding), undefined);
});

test('primarySessionId returns undefined when evidence is empty', () => {
  const finding: SubmitFindingInput = {
    analyst: 'rules-v1',
    kind: 'failure_loop',
    title: 'test',
    body: 'body',
    confidence: 0.5,
    evidence: [],
  };
  assert.strictEqual(primarySessionId(finding), undefined);
});

// ---------------------------------------------------------------------------
// findingKey determinism
// ---------------------------------------------------------------------------

function baseFinding(overrides: Partial<SubmitFindingInput> = {}): SubmitFindingInput {
  return {
    analyst: 'rules-v1',
    kind: 'failure_loop',
    title: 'test',
    body: 'body',
    confidence: 0.5,
    evidence: [{ subjectKind: 'session', subjectId: 'session-1', sessionId: 'session-1', locator: {} }],
    ...overrides,
  };
}

test('findingKey produces stable key regardless of property insertion order', () => {
  // Same logical content — key should be identical
  const key1 = findingKey(baseFinding());
  const key2 = findingKey(baseFinding());
  assert.strictEqual(key1, key2, 'same finding must produce same key');
});

test('findingKey differentiates by analyst', () => {
  const key1 = findingKey(baseFinding({ analyst: 'rules-v1' }));
  const key2 = findingKey(baseFinding({ analyst: 'llm-v1' }));
  assert.notStrictEqual(key1, key2, 'different analyst must produce different key');
});

test('findingKey differentiates by kind', () => {
  const key1 = findingKey(baseFinding({ kind: 'failure_loop' }));
  const key2 = findingKey(baseFinding({ kind: 'risky_action' }));
  assert.notStrictEqual(key1, key2, 'different kind must produce different key');
});

// ---------------------------------------------------------------------------
// turnEvidence / sessionEvidence shapes
// ---------------------------------------------------------------------------

test('turnEvidence returns correct object shape', () => {
  const ev = turnEvidence('session-1', 7, 'note text');
  assert.deepEqual(ev, {
    subjectKind: 'turn',
    sessionId: 'session-1',
    locator: { seq: 7 },
    note: 'note text',
  });
});

test('sessionEvidence returns correct object shape', () => {
  const ev = sessionEvidence('session-1', 'note text');
  assert.deepEqual(ev, {
    subjectKind: 'session',
    subjectId: 'session-1',
    sessionId: 'session-1',
    locator: {},
    note: 'note text',
  });
});

// ---------------------------------------------------------------------------
// makeFinding
// ---------------------------------------------------------------------------

function baseInput() {
  return {
    analyst: 'rules-v1' as const,
    detector: 'test-detector',
    kind: 'failure_loop' as const,
    title: 'short title',
    body: 'short body',
    confidence: 0.5,
    projectId: 'project-1',
    harnessVersionId: null as string | null,
    evidence: [{ subjectKind: 'session' as const, subjectId: 's1', sessionId: 's1', locator: {} }],
  };
}

test('makeFinding shortens title at 500 and body at 20000', () => {
  const longTitle = 'a'.repeat(600);
  const longBody = 'b'.repeat(25000);
  const result = makeFinding({ ...baseInput(), title: longTitle, body: longBody });

  assert.strictEqual(result.title.length, 500, 'title should be truncated to 500');
  assert.ok(result.title.endsWith('…'), 'truncated title should end with ellipsis');
  assert.strictEqual(result.body.length, 20_000, 'body should be truncated to 20000');
  assert.ok(result.body.endsWith('…'), 'truncated body should end with ellipsis');
});

test('makeFinding clamps confidence to [0, 1]', () => {
  assert.strictEqual(makeFinding({ ...baseInput(), confidence: -0.5 }).confidence, 0, 'below 0 should clamp to 0');
  assert.strictEqual(makeFinding({ ...baseInput(), confidence: 1.5 }).confidence, 1, 'above 1 should clamp to 1');
  assert.strictEqual(makeFinding({ ...baseInput(), confidence: 0.7 }).confidence, 0.7, 'within range unchanged');
});

test('makeFinding converts null analysis to undefined', () => {
  const withNull = makeFinding({ ...baseInput(), analysis: null });
  assert.strictEqual(withNull.analysis, undefined, 'null analysis should become undefined');
});

test('makeFinding passes detector through', () => {
  const result = makeFinding({ ...baseInput(), detector: 'my-detector' });
  assert.strictEqual(result.detector, 'my-detector');
});

// ---------------------------------------------------------------------------
// eventText
// ---------------------------------------------------------------------------

test('eventText joins non-falsy fields with newline', () => {
  const ev: EventRow = {
    id: 'e1',
    session_id: 's1',
    seq: 1,
    type: 'tool',
    title: 'the title',
    body: 'the body',
    command: 'echo hi',
    exit_code: 0,
  };
  assert.strictEqual(eventText(ev), 'the title\necho hi\nthe body');
});

test('eventText excludes null and falsy fields', () => {
  const ev: EventRow = {
    id: 'e1',
    session_id: 's1',
    seq: 1,
    type: 'tool',
    title: 'only title',
    body: null,
    command: null,
    exit_code: 0,
  };
  assert.strictEqual(eventText(ev), 'only title');
});
