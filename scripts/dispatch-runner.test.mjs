// Tests for dispatch-runner.mjs の純関数:
// - parseDispatchRunnerArgs: CLI 引数の検証つきパース
// - buildOutcomeRecord: outcomes.jsonl 1 行分のレコード構築
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES_PATH,
  buildOutcomeRecord,
  parseDispatchRunnerArgs,
} from './dispatch-runner.mjs';
import {
  CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PLAN, CLASS_PR_REVIEW,
} from './orchestrator-classify.mjs';
import { OUTCOME_ESCALATION, OUTCOME_FAILURE, OUTCOME_SUCCESS } from './orchestrator.mjs';

// --- parseDispatchRunnerArgs ---

test('parseDispatchRunnerArgs: 正常系 — 3 引数で decision を返す', () => {
  assert.deepEqual(
    parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'issue', '256']),
    { class: CLASS_IMPLEMENT, kind: 'issue', number: 256 },
  );
  assert.deepEqual(
    parseDispatchRunnerArgs([CLASS_PR_REVIEW, 'pr', '300']),
    { class: CLASS_PR_REVIEW, kind: 'pr', number: 300 },
  );
});

test('parseDispatchRunnerArgs: 引数不足は throw', () => {
  assert.throws(() => parseDispatchRunnerArgs([]), /usage/);
  assert.throws(() => parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'issue']), /usage/);
});

test('parseDispatchRunnerArgs: kind が issue/pr 以外は throw', () => {
  assert.throws(() => parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'task', '1']), /invalid kind/);
});

test('parseDispatchRunnerArgs: number が正整数でなければ throw', () => {
  assert.throws(() => parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'issue', '0']), /invalid number/);
  assert.throws(() => parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'issue', 'abc']), /invalid number/);
  assert.throws(() => parseDispatchRunnerArgs([CLASS_IMPLEMENT, 'issue', '-1']), /invalid number/);
});

test('parseDispatchRunnerArgs: EXPLAIN・PLAN クラスも受け付ける', () => {
  assert.equal(parseDispatchRunnerArgs([CLASS_EXPLAIN, 'issue', '189']).class, CLASS_EXPLAIN);
  assert.equal(parseDispatchRunnerArgs([CLASS_PLAN, 'issue', '206']).class, CLASS_PLAN);
});

// --- buildOutcomeRecord ---

test('buildOutcomeRecord: success record の構造', () => {
  const decision = { class: CLASS_IMPLEMENT, kind: 'issue', number: 256 };
  const rec = buildOutcomeRecord(decision, OUTCOME_SUCCESS, 0, '2026-07-08T00:00:00.000Z');
  assert.deepEqual(rec, {
    ts: '2026-07-08T00:00:00.000Z',
    class: CLASS_IMPLEMENT,
    kind: 'issue',
    number: 256,
    outcome: OUTCOME_SUCCESS,
    exitCode: 0,
  });
});

test('buildOutcomeRecord: failure record（exitCode 非 0）', () => {
  const decision = { class: CLASS_PLAN, kind: 'issue', number: 42 };
  const rec = buildOutcomeRecord(decision, OUTCOME_FAILURE, 1, '2026-07-08T00:00:00.000Z');
  assert.equal(rec.outcome, OUTCOME_FAILURE);
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.number, 42);
});

test('buildOutcomeRecord: escalation record（exitCode 非 0）', () => {
  const decision = { class: CLASS_IMPLEMENT, kind: 'issue', number: 100 };
  const rec = buildOutcomeRecord(decision, OUTCOME_ESCALATION, 1, '2026-07-08T00:00:00.000Z');
  assert.equal(rec.outcome, OUTCOME_ESCALATION);
});

test('buildOutcomeRecord: PR_REVIEW クラス・pr kind', () => {
  const decision = { class: CLASS_PR_REVIEW, kind: 'pr', number: 300 };
  const rec = buildOutcomeRecord(decision, OUTCOME_SUCCESS, 0, '2026-07-08T00:00:00.000Z');
  assert.equal(rec.class, CLASS_PR_REVIEW);
  assert.equal(rec.kind, 'pr');
  assert.equal(rec.number, 300);
});

test('buildOutcomeRecord: exitCode null は null のまま保存', () => {
  const decision = { class: CLASS_IMPLEMENT, kind: 'issue', number: 1 };
  const rec = buildOutcomeRecord(decision, OUTCOME_FAILURE, null, '2026-07-08T00:00:00.000Z');
  assert.equal(rec.exitCode, null);
});

// --- OUTCOMES_PATH が RUNS_DIR 配下を指すこと ---

test('OUTCOMES_PATH は .lathe/runs/outcomes.jsonl を指す', () => {
  assert.ok(OUTCOMES_PATH.endsWith('.lathe/runs/outcomes.jsonl'), `unexpected: ${OUTCOMES_PATH}`);
});
