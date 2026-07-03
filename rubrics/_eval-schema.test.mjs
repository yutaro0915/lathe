#!/usr/bin/env node
// rubrics/_eval-schema.test.mjs — _eval-schema.mjs の負テスト（検証器自体の検証 / silent failure 対策、
// ADR 0019 前線 B）。_schema.test.mjs と同型の in-memory fixture 方式。
//   node rubrics/_eval-schema.test.mjs  → 全 assert 通過で "PASS" を出力、失敗で throw（exit≠0）。
import assert from 'node:assert/strict';
import { parseEvalFull, validateEval } from './_eval-schema.mjs';

const goodText = `---
id: x-v1
role: development
frontier: 前線X
S: 状態
C: 条件
Y: 結果
checks:
  - meta/a
inline_criteria: []
trials: { n: 1, aggregate: all-pass }
---
body`;

const v = (text, fileId = 'x-v1') => validateEval(parseEvalFull(text), fileId);
const has = (text, needle, fileId = 'x-v1') => v(text, fileId).some((m) => m.includes(needle));

// 正常 eval は違反 0（検証器が誤検出しない）
assert.equal(v(goodText).length, 0, '正常 eval は違反 0');
// checks: [] でも inline_criteria があれば合格
assert.equal(v(goodText.replace('checks:\n  - meta/a', 'checks: []').replace('inline_criteria: []', 'inline_criteria:\n  - 条件A')).length, 0, 'checks 空 + inline あり は合格');

// 各必須要素の欠落・不正を検出すること（silent failure でない）
assert.ok(has(goodText.replace('id: x-v1\n', ''), 'id 欠落'), 'id 欠落を検出');
assert.ok(has(goodText, '不一致', 'other-file'), 'id とファイル名の不一致を検出');
assert.ok(has(goodText.replace('role: development', 'role: bogus'), 'role'), '不正 role を検出');
assert.ok(has(goodText.replace('frontier: 前線X\n', ''), 'frontier'), 'frontier 欠落を検出');
assert.ok(has(goodText.replace('S: 状態\n', ''), 'S 欠落'), 'S 欠落を検出');
assert.ok(has(goodText.replace('Y: 結果\n', ''), 'Y 欠落'), 'Y 欠落を検出');
assert.ok(has(goodText.replace('checks:\n  - meta/a\n', ''), 'checks 欠落'), 'checks 未宣言を検出');
assert.ok(has(goodText.replace('inline_criteria: []\n', ''), 'inline_criteria 欠落'), 'inline_criteria 未宣言を検出');
assert.ok(has(goodText.replace('checks:\n  - meta/a', 'checks: []'), '両方空'), '判定基準ゼロ（checks/inline 両方空）を検出');
assert.ok(has(goodText.replace('trials: { n: 1, aggregate: all-pass }', 'trials: { n: 0, aggregate: all-pass }'), 'trials.n'), 'n=0 を検出');
assert.ok(has(goodText.replace('all-pass', 'majority'), 'aggregate'), '未定義 aggregate を検出');
assert.ok(has(goodText.replace('trials: { n: 1, aggregate: all-pass }\n', ''), 'trials'), 'trials 欠落を検出');
assert.ok(has(goodText.replace('trials: { n: 1, aggregate: all-pass }', 'trials: sometimes'), '書式が不正'), 'trials 書式不正を検出');

console.log('PASS: _eval-schema.test.mjs — 正常 eval 素通り + 12 欠陥パターン検出');
