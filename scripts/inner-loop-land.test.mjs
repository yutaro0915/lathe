// Tests for the LAND review 前置 (#201 分解 11-12 / #188): pure verdict/round
// decisions and the landing orchestration (push → pr create, arm しない →
// reviewer → PASS arm / CHANGES 差し戻し → 再 review / 超過・不正 → escalate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideLandReviewAction,
  parsePrNumberFromUrl,
  extractLatestPlanCommentText,
  landBranchWithReview,
} from './inner-loop-land.mjs';
import {
  MAX_LAND_REVIEW_REWORK_ROUNDS,
  LAND_REVIEW_MANIFEST_STAGE,
  LAND_REWORK_MANIFEST_STAGE,
} from './inner-loop-core.mjs';

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

// --- landBranchWithReview (orchestration; 全副作用を fake で注入) ---
//
// One fake spawnSync routes git log/push/rev-parse/diff and gh pr
// list/create/diff/comment/merge, plus the reviewer's `claude` spawn
// (review-engine 流儀). The rework IMPLEMENT spawn is injected via
// deps.runStage so implementer behaviour (head advance / verdict) is scripted.
function makeLandDeps({
  reviewerResults = ['looks good\nVERDICT: PASS'],
  implementerResults = ['fixed\nVERDICT: IMPL_DONE'],
  existingPrs = [],
  diff = '+line',
  deltaDiff = '+delta line',
  advanceHeadOnRework = true,
  commentStatus = 0,
  failAt = null,
} = {}) {
  const calls = [];
  const posted = [];
  const recorded = [];
  const reviewerPrompts = [];
  const reworkCalls = [];
  let head = 'sha-0';
  let reviewerCall = 0;
  let implementerCall = 0;
  const spawn = (cmd, args, opts = {}) => {
    const key = `${cmd} ${args.slice(0, 2).join(' ')}`.trim();
    calls.push({ cmd, args, key });
    if (failAt && key.startsWith(failAt)) return { status: 1, stdout: '', stderr: 'boom' };
    if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: 'feat: subject line\n\ncommit body text\0', stderr: '' };
    if (cmd === 'git' && args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (cmd === 'git' && args[0] === '-C' && args[2] === 'diff') return { status: 0, stdout: deltaDiff, stderr: '' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(existingPrs), stderr: '' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/o/r/pull/77\n', stderr: '' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return { status: 0, stdout: diff, stderr: '' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
      posted.push({ prNumber: args[2], body: opts.input });
      return { status: commentStatus, stdout: '', stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'claude') {
      const result = reviewerResults[Math.min(reviewerCall, reviewerResults.length - 1)];
      reviewerCall++;
      reviewerPrompts.push(args[1]); // reviewerArgs = ['-p', prompt, ...]
      return { status: 0, stdout: JSON.stringify({ session_id: `rev-${reviewerCall}`, result, total_cost_usd: 0.1 }), stderr: '' };
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  const runStage = (stage, prompt, cwd, resumeSessionId, backend) => {
    const result = implementerResults[Math.min(implementerCall, implementerResults.length - 1)];
    implementerCall++;
    reworkCalls.push({ stage, prompt, cwd, backend });
    if (advanceHeadOnRework) head = `sha-${implementerCall}`;
    return { session_id: `impl-${implementerCall}`, result, total_cost_usd: 0.2, backend: 'claude' };
  };
  return {
    deps: { spawnSync: spawn, log: () => {}, recordManifestEntry: (e) => recorded.push(e), runStage },
    calls, posted, recorded, reviewerPrompts, reworkCalls,
    reviewerCalls: () => reviewerCall,
  };
}

const LAND_ARGS = {
  branch: 'inner/issue-42',
  issueNumber: 42,
  worktreePath: '/tmp/wt-42',
  issue: { title: 'fix: the thing', body: 'plan body', comments: [] },
  planText: 'confirmed plan text',
};

test('landBranchWithReview: PASS — push → pr create（arm しない）→ review → comment → arm の順', () => {
  const f = makeLandDeps();
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 77);
  assert.equal(result.reworkRoundsUsed, 0);

  const keys = f.calls.map((c) => c.key);
  const at = (k) => keys.findIndex((key) => key.startsWith(k));
  assert.ok(at('git log --reverse') < at('git push -u'));
  assert.ok(at('git push -u') < at('gh pr create'));
  // arm は PR 作成直後ではなく review PASS の後 (#201 分解 11)
  assert.ok(at('gh pr create') < at('claude -p'));
  assert.ok(at('claude -p') < at('gh pr comment'));
  assert.ok(at('gh pr comment') < at('gh pr merge'));

  // reviewer prompt は plan 照合と関連 issue を持つ
  assert.ok(f.reviewerPrompts[0].includes('## 確定 plan'));
  assert.ok(f.reviewerPrompts[0].includes('confirmed plan text'));
  assert.ok(f.reviewerPrompts[0].includes('## 関連 issue #42'));
  // 記録: LAND_REVIEW entry (verdict PASS)
  assert.equal(f.recorded.length, 1);
  assert.equal(f.recorded[0].stage, LAND_REVIEW_MANIFEST_STAGE);
  assert.equal(f.recorded[0].verdict, 'PASS');
});

test('landBranchWithReview: CHANGES → rework（同一 worktree）→ push → 再 review → PASS で arm', () => {
  const f = makeLandDeps({
    reviewerResults: ['finding: missing test\nVERDICT: CHANGES', 'resolved\nVERDICT: PASS'],
  });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.reworkRoundsUsed, 1);

  // rework は IMPLEMENT として同一 worktree で走り、所見が単一の口経由で注入される
  assert.equal(f.reworkCalls.length, 1);
  assert.equal(f.reworkCalls[0].stage, 'IMPLEMENT');
  assert.equal(f.reworkCalls[0].cwd, '/tmp/wt-42');
  assert.ok(f.reworkCalls[0].prompt.includes('## 前回 review 所見（LAND review CHANGES — PR #77 修正周回 1/2）'));
  assert.ok(f.reworkCalls[0].prompt.includes('finding: missing test'));

  // 追い commit push（PR 自動更新 — 新 PR を作らない）
  const reworkPush = f.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'push' && c.args[1] === 'origin');
  assert.equal(reworkPush.length, 1);
  assert.equal(f.calls.filter((c) => c.key === 'gh pr create').length, 1);

  // 再 review の文脈: 前回所見＋対応表明＋前回 head からの差分 (#188)
  const second = f.reviewerPrompts[1];
  assert.ok(second.includes('## 再 review 文脈（CHANGES 差し戻し後の修正周回 1/2）'));
  assert.ok(second.includes('finding: missing test'));
  assert.ok(second.includes('implementer の対応表明'));
  assert.ok(second.includes('fixed'));
  assert.ok(second.includes('前回 head（sha-0）からの差分'));
  assert.ok(second.includes('+delta line'));

  // 全周回の所見が PR コメント列に (#188 設計要求 5)、manifest は 3 entries
  assert.equal(f.posted.length, 2);
  assert.deepEqual(f.recorded.map((e) => [e.stage, e.verdict]), [
    [LAND_REVIEW_MANIFEST_STAGE, 'CHANGES'],
    [LAND_REWORK_MANIFEST_STAGE, 'IMPL_DONE'],
    [LAND_REVIEW_MANIFEST_STAGE, 'PASS'],
  ]);
  assert.equal(f.recorded[1].head_sha, 'sha-1');
  // arm は 1 回だけ・最後
  assert.equal(f.calls.filter((c) => c.key === 'gh pr merge').length, 1);
});

test('landBranchWithReview: CHANGES が上限を超えたら escalate（arm しない・全周回がコメント列）', () => {
  const f = makeLandDeps({ reviewerResults: ['still bad\nVERDICT: CHANGES'] });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, LAND_REVIEW_MANIFEST_STAGE);
  assert.equal(result.verdict, 'CHANGES');
  assert.equal(result.prNumber, 77);
  assert.match(result.excerpt, /修正周回上限超過/);
  assert.match(result.excerpt, /PR #77/);
  assert.match(result.excerpt, /可追跡/);
  // 3 reviews (初回 + 再 review 2), 2 reworks, arm なし
  assert.equal(f.reviewerCalls(), 3);
  assert.equal(f.reworkCalls.length, MAX_LAND_REVIEW_REWORK_ROUNDS);
  assert.equal(f.posted.length, 3);
  assert.ok(!f.calls.some((c) => c.key === 'gh pr merge'));
});

test('landBranchWithReview: reviewer の ESCALATE verdict は rework せず即 escalate', () => {
  const f = makeLandDeps({ reviewerResults: ['premise broken\nVERDICT: ESCALATE'] });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'ESCALATE');
  assert.equal(f.reworkCalls.length, 0);
  assert.ok(!f.calls.some((c) => c.key === 'gh pr merge'));
  // ESCALATE も記録としてコメントされる（可追跡性）
  assert.equal(f.posted.length, 1);
});

test('landBranchWithReview: unparsable verdict は retry 後 escalate（コメントは投稿しない）', () => {
  const f = makeLandDeps({ reviewerResults: ['no verdict here'] });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'UNPARSABLE');
  assert.equal(f.reviewerCalls(), 2); // 1 retry (engine 流儀)
  assert.equal(f.posted.length, 0);
  assert.equal(f.recorded[0].verdict, 'UNPARSABLE');
});

test('landBranchWithReview: 既存 open PR を再利用し gh pr create しない（resume 安全, #188 設計要求 4）', () => {
  const f = makeLandDeps({
    existingPrs: [{ number: 55, title: 't', body: 'b', headRefName: 'inner/issue-42', url: 'https://x/pull/55' }],
  });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 55);
  assert.ok(!f.calls.some((c) => c.key === 'gh pr create'));
});

test('landBranchWithReview: zero-commit rework（全指摘却下の対応表明）は push せず再 review へ', () => {
  const f = makeLandDeps({
    reviewerResults: ['disputed finding\nVERDICT: CHANGES', 'justification accepted\nVERDICT: PASS'],
    implementerResults: ['指摘は当たらない: 理由...\nVERDICT: IMPL_DONE'],
    advanceHeadOnRework: false,
    deltaDiff: '',
  });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.reworkRoundsUsed, 1);
  // rework push なし（commit が進んでいない）
  assert.ok(!f.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push' && c.args[1] === 'origin'));
  // 再 review には対応表明と「差分なし」が載る
  assert.ok(f.reviewerPrompts[1].includes('指摘は当たらない'));
  assert.ok(f.reviewerPrompts[1].includes('差分なし'));
});

test('landBranchWithReview: rework が IMPL_DONE 以外なら escalate', () => {
  const f = makeLandDeps({
    reviewerResults: ['bad\nVERDICT: CHANGES'],
    implementerResults: ['cannot proceed\nVERDICT: ESCALATE'],
  });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, LAND_REWORK_MANIFEST_STAGE);
  assert.equal(result.verdict, 'ESCALATE');
  assert.ok(!f.calls.some((c) => c.key === 'gh pr merge'));
});

test('landBranchWithReview: push 失敗は PR 作成前に fail（旧 landBranch と同じ前段ガード）', () => {
  const f = makeLandDeps({ failAt: 'git push' });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'LAND');
  assert.ok(!f.calls.some((c) => c.cmd === 'gh'));
});

test('landBranchWithReview: コメント投稿失敗は非致命（運搬は envelope — #188 設計要求 1）', () => {
  const f = makeLandDeps({ commentStatus: 1 });
  const result = landBranchWithReview(LAND_ARGS, f.deps);
  assert.equal(result.ok, true); // PASS はそのまま arm される
  assert.ok(f.calls.some((c) => c.key === 'gh pr merge'));
});
