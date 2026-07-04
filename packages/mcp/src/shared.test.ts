import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertMaxLength, cleanNumber, cleanString, normalizeLimit } from './shared';

test('cleanString returns undefined for undefined and whitespace-only inputs', () => {
  const cases: Array<{ name: string; input: string | undefined; expected: string | undefined }> = [
    { name: 'undefined', input: undefined, expected: undefined },
    { name: 'empty string', input: '', expected: undefined },
    { name: 'whitespace only', input: '   ', expected: undefined },
    { name: 'tab only', input: '\t', expected: undefined },
  ];

  for (const { name, input, expected } of cases) {
    assert.strictEqual(cleanString(input), expected, name);
  }
});

test('cleanString trims surrounding whitespace', () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: 'leading space', input: '  hello', expected: 'hello' },
    { name: 'trailing space', input: 'hello  ', expected: 'hello' },
    { name: 'both sides', input: '  hello  ', expected: 'hello' },
    { name: 'no whitespace', input: 'hello', expected: 'hello' },
  ];

  for (const { name, input, expected } of cases) {
    assert.strictEqual(cleanString(input), expected, name);
  }
});

test('cleanNumber returns fallback for non-finite inputs', () => {
  const fallback = 99;
  const cases: Array<{ name: string; input: number | undefined }> = [
    { name: 'undefined', input: undefined },
    { name: 'NaN', input: Number.NaN },
    { name: 'Infinity', input: Infinity },
    { name: '-Infinity', input: -Infinity },
  ];

  for (const { name, input } of cases) {
    assert.strictEqual(cleanNumber(input, fallback), fallback, name);
  }
});

test('cleanNumber clamps negative to 0 and truncates decimals', () => {
  const cases: Array<{ name: string; input: number; expected: number }> = [
    { name: 'negative', input: -3, expected: 0 },
    { name: 'truncate positive decimal', input: 3.9, expected: 3 },
    { name: 'truncate small decimal', input: 0.99, expected: 0 },
    { name: 'exact integer', input: 5, expected: 5 },
    { name: 'negative decimal', input: -0.5, expected: 0 },
  ];

  for (const { name, input, expected } of cases) {
    assert.strictEqual(cleanNumber(input, 99), expected, name);
  }
});

test('normalizeLimit applies defaults and bounds', () => {
  const cases: Array<{ name: string; input: number | undefined; expected: number }> = [
    { name: 'undefined → DEFAULT_LIMIT (50)', input: undefined, expected: 50 },
    { name: 'NaN → DEFAULT_LIMIT (50)', input: Number.NaN, expected: 50 },
    { name: '0 → min clamp (1)', input: 0, expected: 1 },
    { name: '9999 → MAX_LIMIT (200)', input: 9999, expected: 200 },
    { name: 'within range', input: 100, expected: 100 },
  ];

  for (const { name, input, expected } of cases) {
    assert.strictEqual(normalizeLimit(input), expected, name);
  }
});

test('assertMaxLength does not throw for undefined and values within limit', () => {
  assert.doesNotThrow(() => assertMaxLength('label', undefined, 10), 'undefined should not throw');
  assert.doesNotThrow(() => assertMaxLength('label', '', 10), 'empty string should not throw');
  assert.doesNotThrow(() => assertMaxLength('label', 'hello', 5), 'length == max should not throw');
  assert.doesNotThrow(() => assertMaxLength('label', 'hi', 5), 'length < max should not throw');
});

test('assertMaxLength throws when value exceeds max', () => {
  const cases: Array<{ name: string; value: string; max: number }> = [
    { name: 'max+1', value: 'hello!', max: 5 },
    { name: 'way over', value: 'x'.repeat(20), max: 10 },
  ];

  for (const { name, value, max } of cases) {
    assert.throws(
      () => assertMaxLength('label', value, max),
      new RegExp(`must be ${max} characters or fewer`),
      name,
    );
  }
});
