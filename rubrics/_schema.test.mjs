#!/usr/bin/env node
// rubrics/_schema.test.mjs — _schema.mjs の負テスト（検証器自体の検証 / silent failure 対策、ADR 0010 §Development eval）。
//   node rubrics/_schema.test.mjs  → 全 assert 通過で "PASS" を出力、失敗で throw（exit≠0）。
import assert from 'node:assert/strict';
import { validateRubric } from './_schema.mjs';

const good = {
  schema_version: '2', id: 'x/y', title: 't', version: '1', scope: ['x'],
  checks: [{ id: 'c', value: 'v', severity: 'blocker',
    verify: { kind: 'cmd', cmd: 'true', expect: 'eq:0', metric: 'count' } }],
};

// 正常 v2 rubric は違反 0（検証器が誤検出しない）
assert.equal(validateRubric(good, 'x/y').length, 0, '正常 v2 rubric は違反 0');
// v1（schema_version 無し）は対象外＝違反 0
assert.equal(validateRubric({ ...good, schema_version: undefined }, 'x/y').length, 0, 'v1 は検証対象外');

const has = (obj, id, needle) => validateRubric(obj, id).some((m) => m.includes(needle));

// 各必須要素の欠落を検出すること（検証器が素通りしない＝silent failure でない）
assert.ok(has({ ...good, checks: [{ ...good.checks[0], severity: undefined }] }, 'x/y', 'severity'), 'severity 欠落を検出');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], value: undefined }] }, 'x/y', 'value'), 'value 欠落を検出');
assert.ok(has({ ...good, version: undefined }, 'x/y', 'version'), 'version 欠落を検出');
assert.ok(has(good, 'wrong/id', '不一致'), 'id 不一致を検出');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'judge', judge: { prompt: 'p' }, expect: 'eq:0', metric: 'count' } }] }, 'x/y', 'judge'), 'judge.input_cmd 欠落を検出');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'cmd', cmd: 'true', expect: 'eq:0' } }] }, 'x/y', 'metric'), 'metric 欠落を検出');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'cmd', cmd: 'true', expect: 'bogus', metric: 'count' } }] }, 'x/y', 'expect'), '不正 expect を検出');

// named verifier への名前結合（ADR 0020 前線 C）
assert.equal(validateRubric({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'cmd', verifier: 'depcruise', channel: 'I2-package', expect: 'le:1', metric: 'count' } }] }, 'x/y').length, 0, 'verifier+channel の名前結合は合格');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'cmd', verifier: 'depcruise', expect: 'le:1', metric: 'count' } }] }, 'x/y', 'channel 必須'), 'channel 欠落を検出');
assert.ok(has({ ...good, checks: [{ ...good.checks[0], verify: { kind: 'cmd', cmd: 'true', verifier: 'depcruise', channel: 'x', expect: 'eq:0', metric: 'count' } }] }, 'x/y', '同時指定'), 'cmd と verifier の二重指定を検出');

// 選定層向け任意フィールド（ADR 0021 前線 D）
assert.equal(validateRubric({ ...good, invariant: true }, 'x/y').length, 0, 'invariant:true は合格');
assert.ok(has({ ...good, invariant: 'yes' }, 'x/y', 'invariant'), 'invariant が boolean でないと検出');
assert.equal(validateRubric({ ...good, edges: [{ from: 'apps/web/app/globals.css', reason: 'design token 変更は styling 検査を誘発' }] }, 'x/y').length, 0, 'edges 正常形は合格');
assert.ok(has({ ...good, edges: [{ reason: 'r' }] }, 'x/y', 'from'), 'edges[].from 欠落を検出');
assert.ok(has({ ...good, edges: [{ from: 'x' }] }, 'x/y', 'reason'), 'edges[].reason 欠落を検出');
assert.ok(has({ ...good, edges: 'not-array' }, 'x/y', 'edges'), 'edges が配列でないと検出');

console.log('PASS: _schema.test.mjs — 正常 rubric 素通り + 9 欠陥パターン検出 + 名前結合の受理 + 選定層任意フィールド 5 パターン');
