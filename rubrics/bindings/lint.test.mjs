#!/usr/bin/env node
// rubrics/bindings/lint.test.mjs — bindings-lint の負テスト（検証器自体の検証 / silent failure 対策、
// ADR 0018 前線 A の Development eval「壊した fixture を検出できるか」）。_schema.test.mjs と同型の
// in-memory fixture 方式（ディスクに fixture を置かない＝schema 走査を汚染しない）。
//   node rubrics/bindings/lint.test.mjs  → 全 assert 通過で "PASS" を出力、失敗で throw（exit≠0）。
import assert from 'node:assert/strict';
import { extractFrontmatter, parseGroundedIn, parseEvalFile, computeBindings } from './lint.mjs';

// --- parse 層 ---

const fmBlock = `name: x
grounded_in:
  - rubric: meta/a
    verified: "1"
  - rubric: apps/web/b
    verified: "2"`;
{
  const g = parseGroundedIn(fmBlock);
  assert.equal(g.declared, true);
  assert.deepEqual(g.entries, [
    { rubric: 'meta/a', verified: '1' },
    { rubric: 'apps/web/b', verified: '2' },
  ]);
  assert.equal(g.errors.length, 0, 'block 形式を正しく読む');
}
{
  const g = parseGroundedIn('name: x\ngrounded_in: []');
  assert.equal(g.declared, true);
  assert.equal(g.entries.length, 0, '明示空 [] を読む');
}
{
  const g = parseGroundedIn('name: x');
  assert.equal(g.declared, false, '未宣言を空と区別する');
}
{
  const g = parseGroundedIn('name: x\ngrounded_in: yes');
  assert.ok(g.errors.length > 0, '不正なインライン値を検出');
}
{
  const fm = extractFrontmatter('---\nid: e1\nchecks:\n  - meta/a\n---\nbody');
  assert.ok(fm && fm.includes('id: e1'), 'frontmatter 抽出');
  const p = parseEvalFile('---\nid: e1\nchecks:\n  - meta/a\n  - meta/b\n---\nbody');
  assert.equal(p.id, 'e1');
  assert.deepEqual(p.checks, ['meta/a', 'meta/b']);
  assert.equal(p.errors.length, 0);
}
{
  const p = parseEvalFile('---\nchecks: []\n---\n');
  assert.ok(p.errors.some((e) => e.includes('id')), 'eval id 欠落を検出');
}

// --- 集計層（壊した fixture の検出） ---

const rubrics = new Map([
  ['meta/a', { version: '1' }],
  ['meta/b', { version: '2' }],
  ['legacy/v1', { version: null }], // v1（版なし）
]);
const skill = (name, fm) => ({ name, groundedIn: parseGroundedIn(fm) });
const evalOf = (text) => ({ file: 'x.md', parsed: parseEvalFile(text) });
const kinds = (r) => r.violations.map((v) => v.kind);

// 正常系: 違反 0・参照どおりの bindings・未参照 rubric が report に出る
{
  const r = computeBindings({
    skills: [skill('s1', 'grounded_in:\n  - rubric: meta/a\n    verified: "1"'), skill('s2', 'grounded_in: []')],
    evals: [evalOf('---\nid: e1\nchecks:\n  - meta/b\n---\n')],
    rubrics,
  });
  assert.equal(r.violations.length, 0, '正常系は違反 0');
  assert.equal(r.stale.length, 0);
  assert.deepEqual(r.unreferenced, ['legacy/v1'], '宙に浮き rubric を一覧化');
}
// 参照実在: 不存在 rubric を指す grounded_in → RED
assert.ok(kinds(computeBindings({
  skills: [skill('s1', 'grounded_in:\n  - rubric: meta/nope\n    verified: "1"')], evals: [], rubrics,
})).includes('unknown-rubric'), '不存在 rubric への結合を検出');
// 版なし（v1）rubric への結合 → RED
assert.ok(kinds(computeBindings({
  skills: [skill('s1', 'grounded_in:\n  - rubric: legacy/v1\n    verified: "1"')], evals: [], rubrics,
})).includes('unversioned-rubric'), 'version 無し rubric への結合を検出');
// verified 不正 → RED
assert.ok(kinds(computeBindings({
  skills: [skill('s1', 'grounded_in:\n  - rubric: meta/a\n    verified: abc')], evals: [], rubrics,
})).includes('bad-verified'), '不正 verified を検出');
assert.ok(kinds(computeBindings({
  skills: [skill('s1', 'grounded_in:\n  - rubric: meta/a')], evals: [], rubrics,
})).includes('bad-verified'), 'verified 欠落を検出');
// grounded_in 未宣言 → RED（空なら [] を明示）
assert.ok(kinds(computeBindings({
  skills: [skill('s1', 'name: s1')], evals: [], rubrics,
})).includes('missing-grounded-in'), '未宣言 skill を検出');
// eval の不存在 check → RED
assert.ok(kinds(computeBindings({
  skills: [], evals: [evalOf('---\nid: e1\nchecks:\n  - meta/nope\n---\n')], rubrics,
})).includes('unknown-check'), 'eval の不存在 check を検出');
// staleness は違反でなく見直し待ちキュー（結果整合）
{
  const r = computeBindings({
    skills: [skill('s1', 'grounded_in:\n  - rubric: meta/b\n    verified: "1"')], evals: [], rubrics,
  });
  assert.equal(r.violations.length, 0, 'stale は gate 違反にしない');
  assert.deepEqual(r.stale, [{ skill: 's1', rubric: 'meta/b', verified: '1', current: '2' }], 'stale をキューに出す');
}

// rubric → named verifier のチャンネル実在（ADR 0020 前線 C）
const verifiers = new Map([['depcruise', new Set(['I1-postgres', 'I2-package'])]]);
{
  const r = computeBindings({
    skills: [], evals: [], rubrics,
    rubricVerifierRefs: [{ rubricId: 'boundaries', checkId: 'i2', verifier: 'depcruise', channel: 'I2-package' }],
    verifiers,
  });
  assert.equal(r.violations.length, 0, '実在する verifier+channel への結合は違反 0');
  assert.ok(r.bindings.some((b) => b.verifier === 'depcruise' && b.channel === 'I2-package'), '結合一覧に rubric→verifier が載る');
}
assert.ok(kinds(computeBindings({
  skills: [], evals: [], rubrics,
  rubricVerifierRefs: [{ rubricId: 'x', checkId: 'c', verifier: 'nope', channel: 'a' }], verifiers,
})).includes('unknown-verifier'), '不存在 verifier への結合を検出');
assert.ok(kinds(computeBindings({
  skills: [], evals: [], rubrics,
  rubricVerifierRefs: [{ rubricId: 'x', checkId: 'c', verifier: 'depcruise', channel: 'nope' }], verifiers,
})).includes('unknown-channel'), '不存在 channel への結合を検出');

console.log('PASS: lint.test.mjs — 正常系素通り + 8 欠陥パターン検出 + stale のキュー分離');
