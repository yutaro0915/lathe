#!/usr/bin/env node
// rubrics/verdict.test.mjs — verdict.mjs の負テスト（ADR 0022 前線2 §6、eval run-validity-v1 criterion 6）。
//   node rubrics/verdict.test.mjs  → 全 assert 通過で "PASS" を出力、失敗で throw（exit≠0）。
// _schema.test.mjs / select.golden.test.mjs と同型の in-memory fixture 方式。
import assert from 'node:assert/strict';
import { classifyCheck, aggregate } from './verdict.mjs';

// --- classifyCheck: severity 判定接続（ADR §3・eval criterion 1） ---

assert.equal(classifyCheck({ ok: true, severity: 'blocker' }), 'pass', 'ok=true は severity に関わらず pass');
assert.equal(classifyCheck({ ok: true, severity: undefined }), 'pass', 'ok=true・severity 無し（v1）も pass');
assert.equal(classifyCheck({ ok: false, severity: 'blocker' }), 'fail', 'blocker 違反は fail');
assert.equal(classifyCheck({ ok: false, severity: 'major' }), 'warn', 'major 違反は warn（旧 severity 相当）');
assert.equal(classifyCheck({ ok: false, severity: 'minor' }), 'warn', 'minor 違反は warn');
assert.equal(classifyCheck({ ok: false, severity: undefined }), 'fail', 'severity 無し（v1 rubric）は現状維持既定で fail');

// --- classifyCheck: invalid（procedureFailure 最優先・eval criterion 2） ---

assert.equal(
  classifyCheck({ ok: false, severity: 'blocker', procedureFailure: { kind: 'verifier-resolution', detail: 'verifier.json 不在' } }),
  'invalid',
  '手続き故障は severity/ok を上書きして invalid'
);
assert.equal(
  classifyCheck({ ok: true, severity: 'blocker', procedureFailure: { kind: 'judge-verdict-missing', detail: 'VERDICT 抽出失敗' } }),
  'invalid',
  'ok=true でも procedureFailure があれば invalid（判定不能を通過扱いしない）'
);

// invalid 検知 5 類（ADR §2）を kind として分類できることを fixture で確認
const invalidKinds = [
  'verifier-resolution',   // (a) verifier 定義解決失敗
  'missing-channel',       // (b) チャンネル欠落
  'extract-failure',       // (c) extract 実行失敗
  'judge-verdict-missing', // (d) judge VERDICT 抽出失敗 / timeout
  'judge-binding-resolution', // (e) judge binding 解決失敗
];
for (const kind of invalidKinds) {
  const v = classifyCheck({ ok: false, severity: 'blocker', procedureFailure: { kind, detail: `${kind} fixture` } });
  assert.equal(v, 'invalid', `invalid 検知 5 類: ${kind} は invalid に分類されること`);
}

// --- aggregate: 集約優先順位（eval criterion 3・4・5） ---

{
  const r = aggregate(['pass', 'pass', 'warn', 'warn', 'not-run']);
  assert.equal(r.stop, false, 'warn のみ・not-run 混在は通過（stop=false）');
  assert.deepEqual(r.counts, { pass: 2, fail: 0, warn: 2, invalid: 0, notRun: 1 }, 'カウントが値ごとに正しく集計される');
}
{
  const r = aggregate(['pass', 'fail', 'warn']);
  assert.equal(r.stop, true, 'fail が 1 つでもあれば停止');
}
{
  const r = aggregate(['pass', 'invalid', 'warn']);
  assert.equal(r.stop, true, 'invalid が 1 つでもあれば停止（判定不能を通さない＝fail と同格）');
}
{
  const r = aggregate(['not-run', 'not-run']);
  assert.equal(r.stop, false, 'not-run のみは通過を妨げない');
}
{
  const r = aggregate([]);
  assert.equal(r.stop, false, '空集合は通過');
  assert.deepEqual(r.counts, { pass: 0, fail: 0, warn: 0, invalid: 0, notRun: 0 });
}

// --- 故障 fixture: 不形式 judge 出力・チャンネル欠落相当（procedureFailure を伴う分類が fail に化けないこと） ---

{
  // 不形式 judge 出力: VERDICT:<int> が最終行に無い → 呼び出し側が procedureFailure を付与する想定
  const malformedJudge = { ok: false, severity: 'blocker', procedureFailure: { kind: 'judge-verdict-missing', detail: 'raw output に VERDICT: が無い' } };
  assert.equal(classifyCheck(malformedJudge), 'invalid', '不形式 judge 出力 fixture は invalid（fail に化けない）');
}
{
  // チャンネル欠落相当: verify.channel が verifier の produces に無い
  const missingChannel = { ok: false, severity: 'blocker', procedureFailure: { kind: 'missing-channel', detail: 'channel "X" が produces に無い' } };
  assert.equal(classifyCheck(missingChannel), 'invalid', 'チャンネル欠落 fixture は invalid（fail に化けない）');
}

console.log('PASS: verdict.test.mjs — 5 値分類（severity 判定接続 + invalid 5 類）・集約優先順位（fail/invalid 停止・warn 通過・not-run 非妨害）・故障 fixture');
