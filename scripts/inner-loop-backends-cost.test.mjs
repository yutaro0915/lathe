// Tests for the codex cost-evidence parsers (split out of
// inner-loop-backends.test.mjs at the #116 shrink to stay under the
// 500-line file-size guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexCostUsd, parseCodexCostReport } from './inner-loop-backends.mjs';

test('parseCodexCostUsd: returns null when codex JSONL has no explicit cost', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_configured', session_id: 'exec-session-123' }),
    JSON.stringify({ type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } }),
  ].join('\n');
  assert.equal(parseCodexCostUsd(jsonl), null);
});

test('parseCodexCostUsd: extracts explicit top-level or payload cost', () => {
  assert.equal(parseCodexCostUsd(JSON.stringify({ type: 'turn_complete', total_cost_usd: 0.0123 })), 0.0123);
  assert.equal(parseCodexCostUsd(JSON.stringify({ type: 'result', payload: { cost_usd: 0.0456 } })), 0.0456);
});

test('parseCodexCostReport: prices observed turn.completed usage when model is known', () => {
  const jsonl = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
    JSON.stringify({ type: 'thread.started', thread_id: '019f2492-1a96-7e81-9c7a-484a11d135ef' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 19943,
        cached_input_tokens: 4992,
        output_tokens: 177,
        reasoning_output_tokens: 170,
      },
    }),
  ].join('\n');

  const report = parseCodexCostReport(jsonl);

  assert.equal(report.model, 'gpt-5-codex');
  assert.deepEqual(report.tokenUsage, {
    input_tokens: 19943,
    cached_input_tokens: 4992,
    output_tokens: 177,
    reasoning_output_tokens: 170,
  });
  assert.equal(report.source, 'codex.jsonl.turn.completed.usage');
  assert.equal(report.costUsd, (((19943 - 4992) * 1.25) + (4992 * 0.125) + (177 * 10)) / 1_000_000);
});

test('parseCodexCostReport: keeps token usage but leaves cost null for unpriced model', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { model: 'codex-unpriced' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 3 },
    }),
  ].join('\n');

  const report = parseCodexCostReport(jsonl);

  assert.equal(report.costUsd, null);
  assert.equal(report.source, 'codex.jsonl.turn.completed.usage.unpriced');
  assert.equal(report.model, 'codex-unpriced');
  assert.deepEqual(report.tokenUsage, {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 5,
    reasoning_output_tokens: 3,
  });
});

test('parseCodexCostReport: observed stdout turn.completed usage without model is recorded as unpriced', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: '019f2492-1a96-7e81-9c7a-484a11d135ef' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 19943,
        cached_input_tokens: 4992,
        output_tokens: 177,
        reasoning_output_tokens: 170,
      },
    }),
  ].join('\n');

  const report = parseCodexCostReport(jsonl);

  assert.equal(report.costUsd, null);
  assert.equal(report.source, 'codex.jsonl.turn.completed.usage.unpriced');
  assert.equal(report.model, null);
  assert.deepEqual(report.tokenUsage, {
    input_tokens: 19943,
    cached_input_tokens: 4992,
    output_tokens: 177,
    reasoning_output_tokens: 170,
  });
  assert.equal(parseCodexCostUsd(jsonl), null);
});

test('parseCodexCostReport: sums multiple turn.completed usage records', () => {
  const jsonl = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2 } }),
  ].join('\n');

  assert.deepEqual(parseCodexCostReport(jsonl).tokenUsage, {
    input_tokens: 30,
    cached_input_tokens: 6,
    output_tokens: 9,
    reasoning_output_tokens: 3,
  });
});

test('parseCodexCostReport: explicit cost wins over token-derived cost', () => {
  const jsonl = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } }),
    JSON.stringify({ type: 'result', payload: { cost_usd: 0.0456 } }),
  ].join('\n');

  const report = parseCodexCostReport(jsonl);

  assert.equal(report.costUsd, 0.0456);
  assert.equal(report.source, 'codex.jsonl.explicit_cost');
  assert.equal(parseCodexCostUsd(jsonl), 0.0456);
});
