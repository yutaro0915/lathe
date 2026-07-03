#!/usr/bin/env node
// rubrics/_verifier-schema.test.mjs — _verifier-schema.mjs の負テスト（検証器自体の検証、ADR 0020 前線 C）。
//   node rubrics/_verifier-schema.test.mjs  → 全 assert 通過で "PASS"、失敗で throw（exit≠0）。
import assert from 'node:assert/strict';
import { validateVerifier } from './_verifier-schema.mjs';

const goodCmd = {
  id: 'depcruise', version: '1', kind: 'cmd',
  run: 'pnpm lint:deps 2>&1',
  produces: {
    'I2-package': { type: 'count', means: 'I2 違反件数', extract: "grep -c 'I2-package' || true" },
    exit: { type: 'measure', means: '終了コード', source: 'exit' },
  },
  limits: '静的解析の範囲のみ',
};
const goodJudge = {
  id: 'judge-runner', version: '1', kind: 'judge-runner',
  produces: { verdict: { type: 'verdict', means: '違反数の判定' } },
  bindings: { standard: { provider: 'codex', model: null } },
  error_tolerance: '迷ったら通す（false RED で時間を奪わない）',
  calibration: { standard: [] },
  limits: '非決定的判定。校正 fixture 整備中',
};

const v = (obj, id) => validateVerifier(obj, id ?? obj.id);
const has = (obj, needle, id) => v(obj, id).some((m) => m.includes(needle));

// 正常系は違反 0
assert.equal(v(goodCmd).length, 0, '正常 cmd verifier は違反 0');
assert.equal(v(goodJudge).length, 0, '正常 judge-runner は違反 0');

// 欠陥パターンの検出（silent failure でない）
assert.ok(has(goodCmd, '不一致', 'other'), 'id とディレクトリの不一致を検出');
assert.ok(has({ ...goodCmd, version: undefined }, 'version'), 'version 欠落を検出');
assert.ok(has({ ...goodCmd, kind: 'bogus' }, 'kind'), '不正 kind を検出');
assert.ok(has({ ...goodCmd, limits: undefined }, 'limits'), 'limits 欠落を検出');
assert.ok(has({ ...goodCmd, run: undefined }, 'run 必須'), 'cmd の run 欠落を検出');
assert.ok(has({ ...goodCmd, produces: {} }, '1 チャンネル以上'), 'produces 空を検出');
assert.ok(has({ ...goodCmd, produces: { x: { type: 'verdict', means: 'm', extract: 'cat' } } }, 'type'), 'cmd の不正 channel type を検出');
assert.ok(has({ ...goodCmd, produces: { x: { type: 'count', means: 'm' } } }, 'extract 必須'), 'extract 欠落を検出');
assert.ok(has({ ...goodCmd, produces: { x: { type: 'count', means: 'm', source: 'exit', extract: 'cat' } } }, '同時に持てない'), 'source:exit + extract の同時指定を検出');
assert.ok(has({ ...goodCmd, produces: { x: { type: 'count', extract: 'cat' } } }, 'means'), 'channel means 欠落を検出');
assert.ok(has({ ...goodJudge, produces: { verdict: { type: 'count', means: 'm' } } }, 'verdict'), 'judge-runner の非 verdict channel を検出');
assert.ok(has({ ...goodJudge, bindings: {} }, '1 クラス以上'), 'bindings 空を検出');
assert.ok(has({ ...goodJudge, bindings: { standard: { provider: 'codex' } } }, 'model キー'), 'model キー欠落を検出（null 明示の強制）');
assert.ok(has({ ...goodJudge, error_tolerance: undefined }, 'error_tolerance'), '誤り許容方針の欠落を検出');
assert.ok(has({ ...goodJudge, calibration: {} }, 'calibration にクラス'), 'クラスの校正エントリ欠落を検出');
assert.ok(has({ ...goodJudge, run: 'echo x' }, 'run を持たない'), 'judge-runner の run 混入を検出');

console.log('PASS: _verifier-schema.test.mjs — 正常 2 種素通り + 16 欠陥パターン検出');
