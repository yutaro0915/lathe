// Tests for the LAND review 前置 (#201 分解 11-12 / #188): pure verdict/round
// decisions and the landing orchestration (push → pr create, arm しない →
// reviewer → PASS arm / CHANGES 差し戻し → 再 review / 超過・不正 → escalate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideLandReviewAction,
  parsePrNumberFromUrl,
  extractLatestPlanCommentText,
} from './inner-loop-land.mjs';
import { MAX_LAND_REVIEW_REWORK_ROUNDS } from './inner-loop-core.mjs';

// --- decideLandReviewAction (#188: verdict 分岐・周回判定の純関数) ---

test('decideLandReviewAction: PASS -> arm regardless of rounds used', () => {
  assert.deepEqual(decideLandReviewAction({ verdict: 'PASS', reworkRoundsUsed: 0 }), { action: 'arm' });
  assert.deepEqual(decideLandReviewAction({ verdict: 'PASS', reworkRoundsUsed: MAX_LAND_REVIEW_REWORK_ROUNDS }), { action: 'arm' });
});

test('decideLandReviewAction: CHANGES under the limit -> rework (上限 2 周)', () => {
  assert.deepEqual(decideLandReviewAction({ verdict: 'CHANGES', reworkRoundsUsed: 0 }), { action: 'rework' });
  assert.deepEqual(decideLandReviewAction({ verdict: 'CHANGES', reworkRoundsUsed: 1 }), { action: 'rework' });
});

test('decideLandReviewAction: CHANGES at the limit -> escalate (修正周回上限超過)', () => {
  const r = decideLandReviewAction({ verdict: 'CHANGES', reworkRoundsUsed: 2 });
  assert.equal(r.action, 'escalate');
  assert.match(r.reason, /修正周回上限超過/);
});

test('decideLandReviewAction: ESCALATE / unknown / null verdicts -> escalate', () => {
  for (const verdict of ['ESCALATE', 'GREEN', null]) {
    const r = decideLandReviewAction({ verdict, reworkRoundsUsed: 0 });
    assert.equal(r.action, 'escalate', `verdict=${verdict}`);
    assert.match(r.reason, /invalid review verdict/);
  }
});

test('decideLandReviewAction: maxReworkRounds is overridable', () => {
  assert.equal(decideLandReviewAction({ verdict: 'CHANGES', reworkRoundsUsed: 0, maxReworkRounds: 0 }).action, 'escalate');
  assert.equal(decideLandReviewAction({ verdict: 'CHANGES', reworkRoundsUsed: 2, maxReworkRounds: 3 }).action, 'rework');
});

// --- parsePrNumberFromUrl ---

test('parsePrNumberFromUrl: extracts the PR number from gh pr create output', () => {
  assert.equal(parsePrNumberFromUrl('https://github.com/yutaro0915/lathe/pull/207\n'), 207);
});

test('parsePrNumberFromUrl: last URL wins; garbage / empty -> null', () => {
  assert.equal(parsePrNumberFromUrl('see /pull/1 then https://x/pull/42'), 42);
  assert.equal(parsePrNumberFromUrl('no url here'), null);
  assert.equal(parsePrNumberFromUrl(null), null);
});

// --- extractLatestPlanCommentText ---

test('extractLatestPlanCommentText: returns the latest ## plan comment body', () => {
  const comments = [
    { body: '## plan\n\nold plan text' },
    { body: '裁定: scope 追記' },
    { body: '## plan\n\nnew plan text\nwith detail' },
  ];
  assert.equal(extractLatestPlanCommentText(comments), 'new plan text\nwith detail');
});

test('extractLatestPlanCommentText: no plan comment / empty -> null', () => {
  assert.equal(extractLatestPlanCommentText([{ body: 'plain comment' }]), null);
  assert.equal(extractLatestPlanCommentText([{ body: '## plan\n\n' }]), null);
  assert.equal(extractLatestPlanCommentText([]), null);
  assert.equal(extractLatestPlanCommentText(null), null);
});
