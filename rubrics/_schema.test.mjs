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

console.log('PASS: _schema.test.mjs — 正常 rubric 素通り + 7 欠陥パターン検出');
