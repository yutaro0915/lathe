import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_MARKER,
  REVIEW_HEADING,
  REVIEW_VERDICT_TOKENS,
  DIFF_CHAR_LIMIT,
  REVIEWER_ALLOWED_TOOLS,
  parseEngineFlags,
  hasReviewRecord,
  deriveReviewTargets,
  extractIssueRefs,
  truncateDiff,
  buildEngineReviewPrompt,
  parseReviewVerdict,
  formatReviewComment,
  reviewerArgs,
  runReviewer,
  reviewOnePr,
} from './review-engine.mjs';

// --- parseEngineFlags ---

test('parseEngineFlags: no flags -> defaults', () => {
  assert.deepEqual(parseEngineFlags([]), { ok: true, dryRun: false, pr: null });
});

test('parseEngineFlags: --dry-run and --pr <n>', () => {
  assert.deepEqual(parseEngineFlags(['--dry-run', '--pr', '42']), { ok: true, dryRun: true, pr: 42 });
});

test('parseEngineFlags: --pr without value / non-numeric / non-positive -> error', () => {
  for (const argv of [['--pr'], ['--pr', 'abc'], ['--pr', '0'], ['--pr', '-3']]) {
    const r = parseEngineFlags(argv);
    assert.equal(r.ok, false, `argv=${JSON.stringify(argv)}`);
    assert.match(r.error, /--pr/);
  }
});

test('parseEngineFlags: unknown flag -> error', () => {
  const r = parseEngineFlags(['--force']);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown flag/);
});

// --- hasReviewRecord / deriveReviewTargets ---
//
// "Awaiting review" is derived from PR contents on every pass (ADR 0031: state
// is derived, not stored). Two record shapes count as reviewed: landBranch's
// landing-time `gh pr review --comment` (a review with `## REVIEW:`) and this
// engine's own marker comment.

test('hasReviewRecord: landBranch review comment (## REVIEW: in reviews) counts', () => {
  const pr = { comments: [], reviews: [{ body: '## REVIEW: PASS\n\nlooks good' }] };
  assert.equal(hasReviewRecord(pr), true);
});

test('hasReviewRecord: engine marker in issue comments counts', () => {
  const pr = { comments: [{ body: `${ENGINE_MARKER}\n${REVIEW_HEADING} CHANGES\n\nfindings` }], reviews: [] };
  assert.equal(hasReviewRecord(pr), true);
});

test('hasReviewRecord: unrelated comments do not count', () => {
  const pr = { comments: [{ body: 'LGTM but see #12' }], reviews: [{ body: 'nit: rename' }] };
  assert.equal(hasReviewRecord(pr), false);
});

test('hasReviewRecord: missing comments/reviews arrays -> false', () => {
  assert.equal(hasReviewRecord({}), false);
});

test('deriveReviewTargets: skips drafts and reviewed PRs, targets the rest', () => {
  const prs = [
    { number: 1, isDraft: true, comments: [], reviews: [] },
    { number: 2, isDraft: false, comments: [], reviews: [{ body: '## REVIEW: PASS' }] },
    { number: 3, isDraft: false, comments: [], reviews: [] },
  ];
  const { targets, skipped } = deriveReviewTargets(prs);
  assert.deepEqual(targets.map((p) => p.number), [3]);
  assert.deepEqual(skipped.map((s) => s.number), [1, 2]);
  assert.equal(skipped[0].reason, 'draft');
  assert.match(skipped[1].reason, /already reviewed/);
});

test('deriveReviewTargets: --pr narrows the set but keeps skip semantics', () => {
  const prs = [
    { number: 5, isDraft: false, comments: [], reviews: [] },
    { number: 6, isDraft: false, comments: [{ body: `${ENGINE_MARKER}` }], reviews: [] },
  ];
  const only5 = deriveReviewTargets(prs, { onlyPr: 5 });
  assert.deepEqual(only5.targets.map((p) => p.number), [5]);
  assert.deepEqual(only5.skipped, []);
  const only6 = deriveReviewTargets(prs, { onlyPr: 6 });
  assert.deepEqual(only6.targets, []);
  assert.deepEqual(only6.skipped.map((s) => s.number), [6]);
});

// --- extractIssueRefs ---

test('extractIssueRefs: dedupes in first-seen order', () => {
  assert.deepEqual(extractIssueRefs('fix (#128) refs #117 and #128 again'), [128, 117]);
});

test('extractIssueRefs: no refs / non-string -> []', () => {
  assert.deepEqual(extractIssueRefs('no refs here'), []);
  assert.deepEqual(extractIssueRefs(null), []);
});

// --- truncateDiff ---

test('truncateDiff: under limit passes through untruncated', () => {
  const { text, truncated } = truncateDiff('short diff');
  assert.equal(text, 'short diff');
  assert.equal(truncated, false);
});

test('truncateDiff: over limit truncates to the limit', () => {
  const { text, truncated } = truncateDiff('x'.repeat(DIFF_CHAR_LIMIT + 1));
  assert.equal(text.length, DIFF_CHAR_LIMIT);
  assert.equal(truncated, true);
});

// --- buildEngineReviewPrompt ---

const PR = { number: 7, title: 'feat: thing', headRefName: 'feat/thing', url: 'https://x/pr/7', body: 'plan body' };

test('buildEngineReviewPrompt: carries PR marker, body, diff, verdict instruction', () => {
  const prompt = buildEngineReviewPrompt({ pr: PR, diffText: '+added line', diffTruncated: false });
  assert.match(prompt, /^PR #7 \/ stage: REVIEW/);
  assert.ok(prompt.includes('plan body'));
  assert.ok(prompt.includes('+added line'));
  assert.ok(prompt.includes(`VERDICT: <TOKEN>`));
  assert.ok(prompt.includes(REVIEW_VERDICT_TOKENS.join(' | ')));
  // The branch is not necessarily checked out — the prompt must forbid the
  // worktree-diff idiom and point at the inline diff instead.
  assert.ok(prompt.includes('git diff main...HEAD'));
  assert.ok(!prompt.includes('截断'));
});

test('buildEngineReviewPrompt: truncated diff tells the reviewer to fetch the full diff', () => {
  const prompt = buildEngineReviewPrompt({ pr: PR, diffText: 'partial', diffTruncated: true });
  assert.ok(prompt.includes('截断'));
  assert.ok(prompt.includes('gh pr diff 7'));
});

test('buildEngineReviewPrompt: includes linked issue section when provided', () => {
  const prompt = buildEngineReviewPrompt({
    pr: PR, diffText: 'd', diffTruncated: false,
    issue: { number: 128, title: 'review engine', body: 'issue body' },
  });
  assert.ok(prompt.includes('## 関連 issue #128'));
  assert.ok(prompt.includes('issue body'));
});

// --- parseReviewVerdict ---

test('parseReviewVerdict: last VERDICT wins, restricted to review tokens', () => {
  assert.equal(parseReviewVerdict('VERDICT: CHANGES\n…\nVERDICT: PASS'), 'PASS');
  assert.equal(parseReviewVerdict('findings\nVERDICT: ESCALATE'), 'ESCALATE');
  assert.equal(parseReviewVerdict('VERDICT: GREEN'), null); // verifier token, not a review token
  assert.equal(parseReviewVerdict('no verdict here'), null);
  assert.equal(parseReviewVerdict(null), null);
});

// --- formatReviewComment ---

test('formatReviewComment: marker + shared heading + findings without VERDICT lines', () => {
  const body = formatReviewComment({ verdict: 'PASS', resultText: 'finding A\nVERDICT: PASS' });
  assert.ok(body.startsWith(`${ENGINE_MARKER}\n${REVIEW_HEADING} PASS\n`));
  assert.ok(body.includes('finding A'));
  // Bare VERDICT lines are stripped from the findings (only the heading carries the verdict).
  assert.ok(!/^VERDICT:/m.test(body.split('\n').slice(2).join('\n')));
});

test('formatReviewComment: output re-detects as a review record (idempotence of the pass)', () => {
  const body = formatReviewComment({ verdict: 'CHANGES', resultText: 'fix X\nVERDICT: CHANGES' });
  assert.equal(hasReviewRecord({ comments: [{ body }], reviews: [] }), true);
});

// --- reviewerArgs ---

test('reviewerArgs: reviewer agent, dontAsk, read-only toolset, no blanket Bash', () => {
  const args = reviewerArgs('<prompt>');
  assert.deepEqual(args.slice(0, 2), ['-p', '<prompt>']);
  assert.ok(args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'reviewer');
  assert.ok(args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk');
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  assert.ok(!allowed.includes('Bash'), 'must not grant blanket Bash');
  assert.ok(!allowed.some((t) => t === 'Edit' || t === 'Write'), 'must be read-only');
  assert.ok(allowed.includes('Bash(gh pr diff *)'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(allowed, REVIEWER_ALLOWED_TOOLS);
});

// --- runReviewer / reviewOnePr (deps-injected fakes) ---

function fakeEnvelope(result) {
  return JSON.stringify({ session_id: 'sess-1', result, total_cost_usd: 0.5 });
}

test('runReviewer: parses the claude envelope', () => {
  const calls = [];
  const deps = {
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: fakeEnvelope('ok\nVERDICT: PASS'), stderr: '' };
    },
  };
  const env = runReviewer('<prompt>', deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].opts.env.LATHE_STAGE, 'REVIEW');
  assert.deepEqual(env, { session_id: 'sess-1', result: 'ok\nVERDICT: PASS', total_cost_usd: 0.5 });
});

test('runReviewer: spawn failure / bad JSON -> null', () => {
  assert.equal(runReviewer('p', { spawnSync: () => ({ status: 1, stdout: '', stderr: 'boom' }) }), null);
  assert.equal(runReviewer('p', { spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }) }), null);
});

// One fake spawnSync routing gh pr diff / gh issue view / claude / gh pr comment.
function makeDeps({ diff = '+line', claudeResults = ['finding\nVERDICT: PASS'], commentStatus = 0 } = {}) {
  const posted = [];
  let claudeCall = 0;
  const spawn = (cmd, args, opts) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') {
      return diff === null
        ? { status: 1, stdout: '', stderr: 'diff failed' }
        : { status: 0, stdout: diff, stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ number: 128, title: 't', body: 'b' }), stderr: '' };
    }
    if (cmd === 'claude') {
      const result = claudeResults[Math.min(claudeCall, claudeResults.length - 1)];
      claudeCall++;
      return { status: 0, stdout: fakeEnvelope(result), stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
      posted.push({ prNumber: args[2], body: opts.input });
      return { status: commentStatus, stdout: '', stderr: commentStatus === 0 ? '' : 'post failed' };
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return { deps: { spawnSync: spawn }, posted, claudeCalls: () => claudeCall };
}

const TARGET_PR = { number: 9, title: 'fix (#128)', headRefName: 'fix/x', url: 'u', body: 'body' };

test('reviewOnePr: happy path — reviews and posts a marker comment', () => {
  const { deps, posted } = makeDeps();
  const r = reviewOnePr(TARGET_PR, deps);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].prNumber, '9');
  assert.ok(posted[0].body.startsWith(ENGINE_MARKER));
  assert.ok(posted[0].body.includes(`${REVIEW_HEADING} PASS`));
});

test('reviewOnePr: diff fetch failure -> no spawn, no comment', () => {
  const { deps, posted, claudeCalls } = makeDeps({ diff: null });
  const r = reviewOnePr(TARGET_PR, deps);
  assert.deepEqual(r, { ok: false, reason: 'diff fetch failed' });
  assert.equal(claudeCalls(), 0);
  assert.equal(posted.length, 0);
});

test('reviewOnePr: empty diff -> skipped as failure, no spawn', () => {
  const { deps, posted } = makeDeps({ diff: '  \n' });
  const r = reviewOnePr(TARGET_PR, deps);
  assert.deepEqual(r, { ok: false, reason: 'empty diff' });
  assert.equal(posted.length, 0);
});

test('reviewOnePr: unparsable verdict retries once, then succeeds', () => {
  const { deps, posted, claudeCalls } = makeDeps({ claudeResults: ['no verdict', 'ok\nVERDICT: CHANGES'] });
  const r = reviewOnePr(TARGET_PR, deps);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'CHANGES');
  assert.equal(claudeCalls(), 2);
  assert.equal(posted.length, 1);
});

test('reviewOnePr: unparsable after retry -> failure, no comment posted', () => {
  const { deps, posted, claudeCalls } = makeDeps({ claudeResults: ['no verdict'] });
  const r = reviewOnePr(TARGET_PR, deps);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unparsable/);
  assert.equal(claudeCalls(), 2);
  assert.equal(posted.length, 0);
});

test('reviewOnePr: comment post failure is reported but verdict is kept (non-fatal record)', () => {
  const { deps } = makeDeps({ commentStatus: 1 });
  const r = reviewOnePr(TARGET_PR, deps);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.reason, 'comment post failed');
});
