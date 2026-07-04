import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  nextState,
  nextPlanLoopState,
  decideResumeState,
  buildManifestEntry,
  buildSkippedPlanEntry,
  buildManifest,
  taskUnitToSlug,
  manifestPathFor,
  readManifestStages,
  stagePermissions,
  stageCwd,
  buildReceiptArgs,
  tailLines,
  MAX_CYCLES,
  isCodexSandboxEpermTriageResult,
  hasApprovedPlanMarker,
  extractApprovedPlan,
  selectRunPlan,
  parseDriverArgs,
  parseApprovedPlanForIssue,
  parseApprovedPlanIssueBlocks,
  resolvePlanIssueDependency,
  buildImplementationIssueBody,
  createImplementationIssues,
  buildPlanLoopCloseComment,
  parseGhIssueNumber,
  backendCostSourceForEnvelope,
  collectReviewHistory,
  buildReviewHistorySummary,
  buildEscalationMarkdown,
  stageRequiresFreshMainRebase,
  rebaseWorktree,
  runStage,
  runStageWithUnparsableRetry,
  collectTouchesGroundingReport,
  WORKTREE_DEPS_INSTALL_ARGS,
  setupWorktreeDeps,
  prepareWorktree,
} from './inner-loop.mjs';
import {
  buildStagePrompt,
  buildResearchPrompt,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildImplementPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  buildTriagePrompt,
} from './inner-loop-prompts.mjs';
import { parseIssueRunHints } from './inner-queue.mjs';
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// --- parseVerdict ---

test('parseVerdict: all valid tokens parse correctly', () => {
  const tokens = ['PLAN_READY', 'ESCALATE', 'IMPL_DONE', 'PASS', 'CHANGES', 'GREEN', 'RED', 'KNOWN', 'NOVEL'];
  for (const token of tokens) {
    const result = parseVerdict(`some agent output\nmore text\nVERDICT: ${token}`);
    assert.equal(result, token, `expected ${token} to parse`);
  }
});

test('parseVerdict: missing VERDICT line → null', () => {
  const result = parseVerdict('the agent said something but forgot the verdict line');
  assert.equal(result, null);
});

test('parseVerdict: empty string → null', () => {
  assert.equal(parseVerdict(''), null);
});

test('parseVerdict: null/undefined input → null', () => {
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(undefined), null);
});

test('parseVerdict: unrecognized token → null (not silently accepted)', () => {
  const result = parseVerdict('VERDICT: MAYBE_LATER');
  assert.equal(result, null);
});

test('parseVerdict: multiple VERDICT lines → last one wins (envelope result tail)', () => {
  const result = parseVerdict('VERDICT: CHANGES\nsome more reasoning\nVERDICT: PASS');
  assert.equal(result, 'PASS');
});

test('parseVerdict: VERDICT embedded mid-text still parses (last match)', () => {
  const result = parseVerdict('I reviewed everything.\n\nVERDICT: GREEN\n');
  assert.equal(result, 'GREEN');
});

// --- ADR 0016: approved plan marker / loop selection ---

test('hasApprovedPlanMarker: detects exact H2 approved plan marker', () => {
  assert.equal(hasApprovedPlanMarker('Intro\n## Plan (approved)\nDo it'), true);
  assert.equal(hasApprovedPlanMarker('Intro\n## Plan (approved)   \nDo it'), true);
});

test('hasApprovedPlanMarker: rejects non-exact headings', () => {
  assert.equal(hasApprovedPlanMarker('### Plan (approved)\nDo it'), false);
  assert.equal(hasApprovedPlanMarker('## Plan (approved) extra\nDo it'), false);
  assert.equal(hasApprovedPlanMarker(' ## Plan (approved)\nDo it'), false);
});

test('extractApprovedPlan: returns content through EOF so nested H2 plan sections are preserved', () => {
  const body = [
    '# issue',
    '',
    '## Plan (approved)',
    'Step 1',
    '### Details',
    'Keep this.',
    '## Scope',
    'Keep this H2 too.',
    '## Verification',
    'Keep this final section.',
  ].join('\n');
  assert.equal(
    extractApprovedPlan(body),
    'Step 1\n### Details\nKeep this.\n## Scope\nKeep this H2 too.\n## Verification\nKeep this final section.',
  );
});

test('selectRunPlan: impl-loop with approved plan marker skips PLAN', () => {
  const result = selectRunPlan({ mode: 'impl', issueBody: '## Plan (approved)\nImplement X.' });
  assert.equal(result.mode, 'impl');
  assert.equal(result.skipPlan, true);
  assert.equal(result.initialState, 'IMPLEMENT');
  assert.deepEqual(result.stages, ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']);
  assert.equal(result.approvedPlan, 'Implement X.');
});

test('selectRunPlan: impl-loop without marker remains backward compatible', () => {
  const result = selectRunPlan({ mode: 'impl', issueBody: 'No approved plan.' });
  assert.equal(result.skipPlan, false);
  assert.equal(result.initialState, 'PLAN');
  assert.deepEqual(result.stages, ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE', 'MERGE']);
});

test('selectRunPlan: plan-loop uses ADR 0016 stage sequence', () => {
  const result = selectRunPlan({ mode: 'plan', issueBody: 'needs plan' });
  assert.equal(result.initialState, 'RESEARCH');
  assert.deepEqual(result.stages, ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'GATE', 'ISSUE_CREATE', 'CLOSE_SOURCE']);
});

test('buildSkippedPlanEntry: creates synthetic skipped PLAN_READY manifest entry', () => {
  const entry = buildSkippedPlanEntry('approved plan text');
  assert.equal(entry.stage, 'PLAN');
  assert.equal(entry.verdict, 'PLAN_READY');
  assert.equal(entry.session_id, null);
  assert.equal(entry.result_text, 'approved plan text');
  assert.equal(entry.skipped, true);
});

test('parseDriverArgs: parses --plan mode and backend flags', () => {
  const parsed = parseDriverArgs(['--plan', '41', '--dry-run', '--backend-plan', 'claude']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.mode, 'plan');
  assert.equal(parsed.issueNumber, 41);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.backendFlags.stages.PLAN, 'claude');
});

test('parseDriverArgs: allows --plan --resume for pending approval gates', () => {
  const parsed = parseDriverArgs(['--plan', '41', '--resume']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.mode, 'plan');
  assert.equal(parsed.issueNumber, 41);
  assert.equal(parsed.resume, true);
});

test('parseDriverArgs: parses impl mode with positional issue', () => {
  const parsed = parseDriverArgs(['41', '--resume']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.mode, 'impl');
  assert.equal(parsed.issueNumber, 41);
  assert.equal(parsed.resume, true);
});

test('parseApprovedPlanForIssue: extracts machine-readable issue fields', () => {
  const parsed = parseApprovedPlanForIssue([
    'Title: feat: add thing',
    'Depends-on: #38',
    'Touches: scripts/inner-loop.mjs, scripts/inner-loop-prompts.mjs',
    'Plan body',
  ].join('\n'));
  assert.deepEqual(parsed, {
    title: 'feat: add thing',
    dependsOn: '#38',
    touches: 'scripts/inner-loop.mjs, scripts/inner-loop-prompts.mjs',
  });
});

test('parseApprovedPlanIssueBlocks: parses multiple issue blocks and rejected candidates', () => {
  const parsed = parseApprovedPlanIssueBlocks([
    'Title: fix: first',
    'Depends-on: none',
    'Touches: scripts/a.mjs',
    'Implement first.',
    '',
    'Title: fix: second',
    'Depends-on: plan#1, #77',
    'Touches: scripts/b.mjs',
    'Implement second.',
    '',
    'Rejected: grounding hook issue — requires undefined contract',
    'VERDICT: PLAN_READY',
  ].join('\n'));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.issues.map((issue) => ({
    index: issue.index,
    title: issue.title,
    dependsOn: issue.dependsOn,
    touches: issue.touches,
  })), [
    { index: 1, title: 'fix: first', dependsOn: '', touches: 'scripts/a.mjs' },
    { index: 2, title: 'fix: second', dependsOn: 'plan#1, #77', touches: 'scripts/b.mjs' },
  ]);
  assert.match(parsed.issues[0].approvedPlan, /Implement first\./);
  assert.match(parsed.issues[1].approvedPlan, /Implement second\./);
  assert.doesNotMatch(parsed.issues[1].approvedPlan, /VERDICT: PLAN_READY/);
  assert.deepEqual(parsed.rejected, [
    { candidate: 'grounding hook issue', reason: 'requires undefined contract' },
  ]);
});

test('parseApprovedPlanIssueBlocks: validates required fields per block', () => {
  const parsed = parseApprovedPlanIssueBlocks([
    'Title: fix: first',
    'Depends-on: none',
    'Touches: scripts/a.mjs',
    'Implement first.',
    '',
    'Title: fix: second',
    'Depends-on: none',
    'Implement second.',
  ].join('\n'));

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /block 2/i);
  assert.match(parsed.error, /Touches:/);
});

test('resolvePlanIssueDependency: replaces earlier plan-local issue references', () => {
  const resolved = resolvePlanIssueDependency('plan#1, #77', new Map([[1, 101]]));
  assert.deepEqual(resolved, { ok: true, dependsOn: '#101, #77' });
});

test('resolvePlanIssueDependency: rejects unresolved plan-local issue references', () => {
  const resolved = resolvePlanIssueDependency('plan#2', new Map([[1, 101]]));
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /plan#2/);
});

test('buildImplementationIssueBody: includes approved plan marker and queue hints', () => {
  const body = buildImplementationIssueBody({
    sourceIssueNumber: 41,
    approvedPlan: 'Title: feat: x\nDepends-on: #38\nTouches: scripts/a.mjs\nDo X.\nVERDICT: PLAN_READY',
    dependsOn: '#38',
    touches: 'scripts/a.mjs',
  });
  assert.match(body, /Generated from #41/);
  assert.match(body, /^Depends-on: #38$/m);
  assert.match(body, /^Touches: scripts\/a\.mjs$/m);
  assert.match(body, /^## Plan \(approved\)$/m);
  assert.doesNotMatch(body, /VERDICT: PLAN_READY/);
});

test('createImplementationIssues: creates every block and resolves plan-local dependencies', () => {
  const calls = [];
  const result = createImplementationIssues(41, [
    'Title: fix: first',
    'Depends-on: none',
    'Touches: scripts/a.mjs',
    'Implement first.',
    '',
    'Title: fix: second',
    'Depends-on: plan#1, #77',
    'Touches: scripts/b.mjs',
    'Implement second.',
    'VERDICT: PLAN_READY',
  ].join('\n'), {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const issueNumber = 101 + calls.length - 1;
      return { status: 0, stdout: `https://github.com/yutaro0915/lathe/issues/${issueNumber}\n`, stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.map((issue) => issue.issueNumber), [101, 102]);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [
    ['issue', 'create'],
    ['issue', 'create'],
  ]);
  assert.match(calls[0].options.input, /^Depends-on: $/m);
  assert.match(calls[1].options.input, /^Depends-on: #101, #77$/m);
  assert.doesNotMatch(calls[1].options.input, /^Depends-on: plan#1, #77$/m);
  assert.deepEqual(parseIssueRunHints(calls[1].options.input).dependsOn, [101, 77]);
});

test('buildPlanLoopCloseComment: includes created issues and rejected candidates', () => {
  const comment = buildPlanLoopCloseComment({
    createdIssues: [
      { index: 1, issueNumber: 101, title: 'fix: first', url: 'https://github.com/yutaro0915/lathe/issues/101' },
      { index: 2, issueNumber: 102, title: 'fix: second', url: 'https://github.com/yutaro0915/lathe/issues/102' },
    ],
    rejected: [
      { candidate: 'grounding hook issue', reason: 'requires undefined contract' },
    ],
  });

  assert.match(comment, /plan-loop created implementation issues:/);
  assert.match(comment, /plan#1 -> #101: fix: first/);
  assert.match(comment, /plan#2 -> #102: fix: second/);
  assert.match(comment, /Rejected candidates:/);
  assert.match(comment, /grounding hook issue — requires undefined contract/);
});

test('collectTouchesGroundingReport: returns raw JSON only for status ok', () => {
  const calls = [];
  const report = { status: 'ok', generatedAt: '2026-07-03T00:00:00.000Z', targetIssue: null, issues: [], advisoryOpenOverlaps: [] };
  const result = collectTouchesGroundingReport({
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
    },
  });

  assert.equal(result, JSON.stringify(report, null, 2));
  assert.deepEqual(calls, [
    {
      cmd: 'pnpm',
      args: ['-C', 'apps/web', 'exec', 'tsx', 'scripts/touches-grounding.ts', '--format', 'json'],
      options: { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1e8 },
    },
  ]);
});

test('collectTouchesGroundingReport: omits unavailable, invalid, and failing reports', () => {
  assert.equal(collectTouchesGroundingReport({
    spawnSync: () => ({ status: 0, stdout: '{"status":"unavailable","generatedAt":"2026-07-03T00:00:00.000Z","reason":"db offline"}', stderr: '' }),
  }), null);

  assert.equal(collectTouchesGroundingReport({
    spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }),
  }), null);

  assert.equal(collectTouchesGroundingReport({
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  }), null);
});

test('parseGhIssueNumber: parses GitHub issue URL', () => {
  assert.equal(parseGhIssueNumber('https://github.com/yutaro0915/lathe/issues/123\n'), 123);
});

test('rebaseWorktree: successful rebase runs rebase main and returns true', () => {
  const calls = [];
  const result = rebaseWorktree('/tmp/wt', {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    { cmd: 'git', args: ['-C', '/tmp/wt', 'rebase', 'main'], options: { stdio: 'inherit' } },
  ]);
});

test('rebaseWorktree: failed rebase aborts before returning false', () => {
  const calls = [];
  const result = rebaseWorktree('/tmp/wt', {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 1 };
    },
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [
    { cmd: 'git', args: ['-C', '/tmp/wt', 'rebase', 'main'], options: { stdio: 'inherit' } },
    { cmd: 'git', args: ['-C', '/tmp/wt', 'rebase', '--abort'], options: { stdio: 'inherit' } },
  ]);
});

// --- worktree deps setup ---

test('worktree deps setup runs pnpm install frozen prefer-offline in the worktree cwd', () => {
  const calls = [];
  const logs = [];
  const times = [1000, 1042];

  const result = setupWorktreeDeps('/tmp/lathe-wt', {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0 };
    },
    now: () => times.shift(),
    log: (msg) => logs.push(msg),
  });

  assert.deepEqual(calls, [
    {
      cmd: 'pnpm',
      args: WORKTREE_DEPS_INSTALL_ARGS,
      options: { cwd: '/tmp/lathe-wt', stdio: 'inherit' },
    },
  ]);
  assert.deepEqual(result, { ok: true, status: 0, error: null, durationMs: 42 });
  assert.match(logs[0], /worktree deps setup succeeded/);
  assert.match(logs[0], /elapsed=42ms/);
});

test('worktree deps setup warns and returns ok false when pnpm install fails', () => {
  const logs = [];
  const times = [2000, 2017];

  const result = setupWorktreeDeps('/tmp/lathe-wt', {
    spawnSync: () => ({ status: 1, error: new Error('offline store miss') }),
    now: () => times.shift(),
    log: (msg) => logs.push(msg),
  });

  assert.deepEqual(result, { ok: false, status: 1, error: 'offline store miss', durationMs: 17 });
  assert.match(logs[0], /warning: worktree deps setup failed/);
  assert.match(logs[0], /status=1/);
  assert.match(logs[0], /error=offline store miss/);
  assert.match(logs[0], /elapsed=17ms/);
  assert.match(logs[0], /continuing with P3 fallback/);
});

test('prepareWorktree creates the git worktree then prepares deps before returning', () => {
  const events = [];
  const expectedPath = join(process.cwd(), '.claude', 'worktrees', 'inner-issue-46');

  const result = prepareWorktree(46, {
    existsSync: () => false,
    spawnSync: (cmd, args, options) => {
      events.push({ type: 'spawn', cmd, args, options });
      return { status: 0 };
    },
    setupWorktreeDeps: (worktreePath) => {
      events.push({ type: 'deps', worktreePath });
      return { ok: true };
    },
  });

  assert.deepEqual(result, { path: expectedPath, branch: 'inner/issue-46' });
  assert.deepEqual(events, [
    {
      type: 'spawn',
      cmd: 'git',
      args: ['worktree', 'add', expectedPath, '-b', 'inner/issue-46', 'main'],
      options: { stdio: 'inherit', cwd: process.cwd() },
    },
    { type: 'deps', worktreePath: expectedPath },
  ]);
});

test('worktree deps dry-run prints the install step and P3 fallback policy for non-resume impl runs', () => {
  const fakeBin = join(tmpdir(), `lathe-inner-loop-gh-${process.pid}-${Date.now()}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = join(fakeBin, 'gh');
  writeFileSync(fakeGh, [
    '#!/bin/sh',
    "cat <<'JSON'",
    '{"number":46,"title":"Issue 46","body":"Body"}',
    'JSON',
    '',
  ].join('\n'), 'utf8');
  chmodSync(fakeGh, 0o755);

  const result = spawnSync(process.execPath, ['scripts/inner-loop.mjs', '46', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });

  rmSync(fakeBin, { recursive: true, force: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dry-run: would create worktree .*inner-issue-46 on branch inner\/issue-46/);
  assert.match(result.stdout, /dry-run: would run pnpm install --frozen-lockfile --prefer-offline in .*inner-issue-46/);
  assert.match(result.stdout, /dry-run: pnpm install failure would warn and continue with P3 fallback/);
});

test('plan-loop dry-run prints touches grounding collection and preview placeholder', () => {
  const result = spawnSync(process.execPath, ['scripts/inner-loop.mjs', '--plan', '46', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dry-run: would collect touches grounding report/);
  assert.match(result.stdout, /unavailable\/non-ok -> omit/);
  assert.match(result.stdout, /^## touches grounding$/m);
  assert.match(result.stdout, /<touches grounding JSON/);
  assert.match(result.stdout, /dry-run: GATE/);
  assert.match(result.stdout, /auto-ok/);
  assert.match(result.stdout, /pending-approval/);
  assert.match(result.stdout, /plan-approved/);
});

function planRunManifestPath(issueNumber) {
  return join(process.cwd(), '.lathe', 'runs', `plan-${issueNumber}.json`);
}

function planRunEscalationPath(issueNumber) {
  return join(process.cwd(), '.lathe', 'runs', `plan-${issueNumber}.escalation.md`);
}

function cleanupPlanRunFiles(issueNumber) {
  rmSync(planRunManifestPath(issueNumber), { force: true });
  rmSync(planRunEscalationPath(issueNumber), { force: true });
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeExecutable(path, body) {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function setupPlanLoopFakeBin(testId) {
  const fakeBin = join(tmpdir(), `lathe-plan-loop-${testId}-${process.pid}-${Date.now()}`);
  mkdirSync(fakeBin, { recursive: true });
  const logPath = join(fakeBin, 'gh.log');

  writeExecutable(join(fakeBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
if (process.env.LATHE_FAKE_GH_LOG) {
  fs.appendFileSync(process.env.LATHE_FAKE_GH_LOG, JSON.stringify({ args, input }) + '\\n');
}
function labelsFromCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}
function labelsForIssueView() {
  const sequence = String(process.env.LATHE_FAKE_LABELS_BY_VIEW || '');
  if (!sequence) return labelsFromCsv(process.env.LATHE_FAKE_LABELS);
  const calls = process.env.LATHE_FAKE_GH_LOG && fs.existsSync(process.env.LATHE_FAKE_GH_LOG)
    ? fs.readFileSync(process.env.LATHE_FAKE_GH_LOG, 'utf8')
      .trim()
      .split(/\\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];
  const viewCount = Math.max(1, calls.filter((call) => call.args[0] === 'issue' && call.args[1] === 'view').length);
  const byView = sequence.split('|');
  return labelsFromCsv(byView[Math.min(viewCount - 1, byView.length - 1)]);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const number = Number(args[2] || 0);
  const labels = labelsForIssueView();
  process.stdout.write(JSON.stringify({ number, title: 'Source issue', body: 'Source body', labels }) + '\\n');
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') process.exit(0);
if (args[0] === 'issue' && args[1] === 'comment') process.exit(0);
if (args[0] === 'issue' && args[1] === 'edit') process.exit(0);
if (args[0] === 'issue' && args[1] === 'create') {
  const issue = Number(process.env.LATHE_FAKE_CREATED_ISSUE || '701');
  process.stdout.write('https://github.com/yutaro0915/lathe/issues/' + issue + '\\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'close') process.exit(0);
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`);

  writeExecutable(join(fakeBin, 'claude'), `#!/usr/bin/env node
const stage = process.env.LATHE_STAGE;
const results = {
  RESEARCH: 'research complete\\nVERDICT: PASS',
  PLAN: [
    'Title: feat: gated implementation',
    'Depends-on: none',
    'Touches: scripts/inner-loop.mjs',
    'Implement the gated issue.',
    'VERDICT: PLAN_READY',
  ].join('\\n'),
  PLAN_REVIEW: 'plan review passed\\nVERDICT: PASS',
};
if (!results[stage]) {
  process.stderr.write('unexpected claude stage: ' + stage + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ session_id: 'session-' + stage, result: results[stage], total_cost_usd: 0.01 }) + '\\n');
`);

  writeExecutable(join(fakeBin, 'pnpm'), '#!/bin/sh\nexit 1\n');

  return {
    fakeBin,
    logPath,
    cleanup: () => rmSync(fakeBin, { recursive: true, force: true }),
  };
}

function runPlanLoopCli(issueNumber, fake, labels, extraArgs = [], envOverrides = {}) {
  return spawnSync(process.execPath, ['scripts/inner-loop.mjs', '--plan', String(issueNumber), ...extraArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fake.fakeBin}:${process.env.PATH}`,
      LATHE_FAKE_GH_LOG: fake.logPath,
      LATHE_FAKE_LABELS: labels,
      LATHE_FAKE_CREATED_ISSUE: '701',
      ...envOverrides,
    },
  });
}

function writePendingPlanGateManifest(issueNumber, approvedPlan) {
  mkdirSync(join(process.cwd(), '.lathe', 'runs'), { recursive: true });
  writeFileSync(planRunManifestPath(issueNumber), JSON.stringify(buildManifest(issueNumber, [
    buildManifestEntry({
      stage: 'RESEARCH',
      sessionId: 'session-RESEARCH',
      verdict: 'PASS',
      backendCostUsd: 0.01,
      backend: 'claude',
      resultText: 'research complete\nVERDICT: PASS',
    }),
    buildManifestEntry({
      stage: 'PLAN',
      sessionId: 'session-PLAN',
      verdict: 'PLAN_READY',
      backendCostUsd: 0.01,
      backend: 'claude',
      resultText: approvedPlan,
    }),
    buildManifestEntry({
      stage: 'PLAN_REVIEW',
      sessionId: 'session-PLAN_REVIEW',
      verdict: 'PASS',
      backendCostUsd: 0.01,
      backend: 'claude',
      resultText: 'plan review passed\nVERDICT: PASS',
    }),
    buildManifestEntry({
      stage: 'GATE',
      sessionId: null,
      verdict: 'PENDING_APPROVAL',
      backendCostUsd: null,
      backend: null,
      resultText: 'pending approval',
    }),
  ], { mode: 'plan-loop' }), null, 2) + '\n', 'utf8');
}

test('plan-loop gates after PLAN_REVIEW PASS unless source issue has auto-ok', () => {
  const issueNumber = 59001;
  cleanupPlanRunFiles(issueNumber);
  const fake = setupPlanLoopFakeBin('gate-pending');

  try {
    const result = runPlanLoopCli(issueNumber, fake, '', ['--backend', 'claude']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pending approval/i);
    assert.equal(existsSync(planRunEscalationPath(issueNumber)), false);

    const manifest = JSON.parse(readFileSync(planRunManifestPath(issueNumber), 'utf8'));
    assert.deepEqual(manifest.stages.map((stage) => [stage.stage, stage.verdict]), [
      ['RESEARCH', 'PASS'],
      ['PLAN', 'PLAN_READY'],
      ['PLAN_REVIEW', 'PASS'],
      ['GATE', 'PENDING_APPROVAL'],
    ]);
    assert.match(manifest.stages.at(-1).result_text, /plan-approved/);
    assert.match(manifest.stages.at(-1).result_text, /node scripts\/inner-loop\.mjs --plan 59001 --resume/);

    const calls = readJsonLines(fake.logPath);
    assert.ok(calls.some((call) => call.args.join(' ') === 'label create pending-approval --force'));
    assert.ok(calls.some((call) => call.args.join(' ') === 'label create plan-approved --force'));
    assert.ok(calls.some((call) => call.args.join(' ') === 'label create auto-ok --force'));
    assert.ok(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'comment' && /Title: feat: gated implementation/.test(call.input)));
    assert.ok(calls.some((call) => call.args.join(' ') === 'issue edit 59001 --add-label pending-approval'));
    assert.equal(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'create'), false);
  } finally {
    cleanupPlanRunFiles(issueNumber);
    fake.cleanup();
  }
});

test('plan-loop source issue with auto-ok bypasses approval gate and creates implementation issue', () => {
  const issueNumber = 59002;
  cleanupPlanRunFiles(issueNumber);
  const fake = setupPlanLoopFakeBin('auto-ok');

  try {
    const result = runPlanLoopCli(issueNumber, fake, 'auto-ok', ['--backend', 'claude']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(planRunManifestPath(issueNumber), 'utf8'));
    assert.deepEqual(manifest.stages.map((stage) => [stage.stage, stage.verdict]), [
      ['RESEARCH', 'PASS'],
      ['PLAN', 'PLAN_READY'],
      ['PLAN_REVIEW', 'PASS'],
      ['GATE', 'PASS'],
      ['ISSUE_CREATE', 'PASS'],
      ['CLOSE_SOURCE', 'PASS'],
    ]);

    const calls = readJsonLines(fake.logPath);
    assert.ok(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'create'));
    assert.equal(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'comment'), false);
    assert.equal(calls.some((call) => call.args.join(' ') === 'issue edit 59002 --add-label pending-approval'), false);
  } finally {
    cleanupPlanRunFiles(issueNumber);
    fake.cleanup();
  }
});

test('plan-loop refetches source labels at GATE before auto-ok bypass', () => {
  const issueNumber = 59005;
  cleanupPlanRunFiles(issueNumber);
  const fake = setupPlanLoopFakeBin('auto-ok-removed-before-gate');

  try {
    const result = runPlanLoopCli(issueNumber, fake, 'auto-ok', ['--backend', 'claude'], {
      LATHE_FAKE_LABELS_BY_VIEW: 'auto-ok|',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pending approval/i);

    const manifest = JSON.parse(readFileSync(planRunManifestPath(issueNumber), 'utf8'));
    assert.deepEqual(manifest.stages.map((stage) => [stage.stage, stage.verdict]), [
      ['RESEARCH', 'PASS'],
      ['PLAN', 'PLAN_READY'],
      ['PLAN_REVIEW', 'PASS'],
      ['GATE', 'PENDING_APPROVAL'],
    ]);

    const calls = readJsonLines(fake.logPath);
    assert.equal(calls.filter((call) => call.args[0] === 'issue' && call.args[1] === 'view').length, 2);
    assert.equal(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'create'), false);
  } finally {
    cleanupPlanRunFiles(issueNumber);
    fake.cleanup();
  }
});

test('plan-loop resume without plan-approved exits 2 and leaves manifest unchanged', () => {
  const issueNumber = 59003;
  const approvedPlan = [
    'Title: feat: gated implementation',
    'Depends-on: none',
    'Touches: scripts/inner-loop.mjs',
    'Implement the gated issue.',
    'VERDICT: PLAN_READY',
  ].join('\n');
  cleanupPlanRunFiles(issueNumber);
  writePendingPlanGateManifest(issueNumber, approvedPlan);
  const before = readFileSync(planRunManifestPath(issueNumber), 'utf8');
  const fake = setupPlanLoopFakeBin('resume-waiting');

  try {
    const result = runPlanLoopCli(issueNumber, fake, '', ['--resume']);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /plan-approved/);
    assert.equal(readFileSync(planRunManifestPath(issueNumber), 'utf8'), before);

    const calls = readJsonLines(fake.logPath);
    assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [['issue', 'view']]);
  } finally {
    cleanupPlanRunFiles(issueNumber);
    fake.cleanup();
  }
});

test('plan-loop resume with plan-approved records GATE pass and creates implementation issue', () => {
  const issueNumber = 59004;
  const approvedPlan = [
    'Title: feat: gated implementation',
    'Depends-on: none',
    'Touches: scripts/inner-loop.mjs',
    'Implement the gated issue.',
    'VERDICT: PLAN_READY',
  ].join('\n');
  cleanupPlanRunFiles(issueNumber);
  writePendingPlanGateManifest(issueNumber, approvedPlan);
  const fake = setupPlanLoopFakeBin('resume-approved');

  try {
    const result = runPlanLoopCli(issueNumber, fake, 'plan-approved', ['--resume']);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(planRunManifestPath(issueNumber), 'utf8'));
    assert.deepEqual(manifest.stages.map((stage) => [stage.stage, stage.verdict]), [
      ['RESEARCH', 'PASS'],
      ['PLAN', 'PLAN_READY'],
      ['PLAN_REVIEW', 'PASS'],
      ['GATE', 'PENDING_APPROVAL'],
      ['GATE', 'PASS'],
      ['ISSUE_CREATE', 'PASS'],
      ['CLOSE_SOURCE', 'PASS'],
    ]);

    const calls = readJsonLines(fake.logPath);
    assert.ok(calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'create'));
  } finally {
    cleanupPlanRunFiles(issueNumber);
    fake.cleanup();
  }
});

// --- nextState: transition table ---

test('nextState: PLAN + PLAN_READY -> IMPLEMENT', () => {
  const { next, cycles } = nextState('PLAN', 'PLAN_READY', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 0);
});

test('nextState: PLAN + ESCALATE -> ESCALATE', () => {
  const { next } = nextState('PLAN', 'ESCALATE', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: IMPLEMENT + IMPL_DONE -> REVIEW', () => {
  const { next } = nextState('IMPLEMENT', 'IMPL_DONE', 0);
  assert.equal(next, 'REVIEW');
});

test('nextState: IMPLEMENT + unexpected verdict -> ESCALATE', () => {
  const { next } = nextState('IMPLEMENT', 'PASS', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: REVIEW + PASS -> VERIFY', () => {
  const { next, cycles } = nextState('REVIEW', 'PASS', 0);
  assert.equal(next, 'VERIFY');
  assert.equal(cycles, 0);
});

test('nextState: REVIEW + CHANGES (cycle 0->1) -> IMPLEMENT', () => {
  const { next, cycles } = nextState('REVIEW', 'CHANGES', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 1);
});

test('nextState: REVIEW + CHANGES within MAX_CYCLES -> IMPLEMENT', () => {
  const { next, cycles } = nextState('REVIEW', 'CHANGES', MAX_CYCLES - 1);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, MAX_CYCLES);
});

test('nextState: REVIEW + CHANGES exceeding MAX_CYCLES -> ESCALATE (CHANGES x3 pattern)', () => {
  // Simulates 3rd CHANGES verdict: cycles already at MAX_CYCLES (2) from two prior CHANGES.
  const { next, cycles } = nextState('REVIEW', 'CHANGES', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, MAX_CYCLES + 1);
});

test('nextState: VERIFY + GREEN -> MERGE', () => {
  const { next } = nextState('VERIFY', 'GREEN', 0);
  assert.equal(next, 'MERGE');
});

test('nextState: VERIFY + RED -> TRIAGE', () => {
  const { next } = nextState('VERIFY', 'RED', 0);
  assert.equal(next, 'TRIAGE');
});

test('nextState: TRIAGE + KNOWN -> IMPLEMENT (cycle increments)', () => {
  const { next, cycles } = nextState('TRIAGE', 'KNOWN', 0);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(cycles, 1);
});

test('nextState: TRIAGE + KNOWN non-implementable environment failure -> ESCALATE', () => {
  const { next, cycles } = nextState('TRIAGE', 'KNOWN', 0, { nonImplementableKnown: true });
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, 0);
});

test('nextState: TRIAGE + KNOWN exceeding MAX_CYCLES -> ESCALATE', () => {
  const { next } = nextState('TRIAGE', 'KNOWN', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
});

test('nextState: TRIAGE + NOVEL -> ESCALATE', () => {
  const { next } = nextState('TRIAGE', 'NOVEL', 0);
  assert.equal(next, 'ESCALATE');
});

test('nextState: full happy path RED->TRIAGE->KNOWN->IMPLEMENT', () => {
  const verify = nextState('VERIFY', 'RED', 0);
  assert.equal(verify.next, 'TRIAGE');
  const triage = nextState('TRIAGE', 'KNOWN', verify.cycles);
  assert.equal(triage.next, 'IMPLEMENT');
  assert.equal(triage.cycles, 1);
});

test('nextState: null verdict (unparsable) -> ESCALATE regardless of state', () => {
  for (const state of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { next } = nextState(state, null, 0);
    assert.equal(next, 'ESCALATE', `state=${state} with null verdict should escalate`);
  }
});

test('nextState: unknown state -> ESCALATE', () => {
  const { next } = nextState('BOGUS_STATE', 'PASS', 0);
  assert.equal(next, 'ESCALATE');
});

// --- nextPlanLoopState: ADR 0016 transition table ---

test('nextPlanLoopState: RESEARCH PASS -> PLAN', () => {
  const { next, cycles } = nextPlanLoopState('RESEARCH', 'PASS', 0);
  assert.equal(next, 'PLAN');
  assert.equal(cycles, 0);
});

test('nextPlanLoopState: PLAN PLAN_READY -> PLAN_REVIEW', () => {
  const { next } = nextPlanLoopState('PLAN', 'PLAN_READY', 0);
  assert.equal(next, 'PLAN_REVIEW');
});

test('nextPlanLoopState: PLAN_REVIEW PASS -> GATE', () => {
  const { next } = nextPlanLoopState('PLAN_REVIEW', 'PASS', 0);
  assert.equal(next, 'GATE');
});

test('nextPlanLoopState: GATE PASS -> ISSUE_CREATE', () => {
  const { next } = nextPlanLoopState('GATE', 'PASS', 0);
  assert.equal(next, 'ISSUE_CREATE');
});

test('nextPlanLoopState: PLAN_REVIEW CHANGES -> PLAN within max cycles', () => {
  const { next, cycles } = nextPlanLoopState('PLAN_REVIEW', 'CHANGES', 0);
  assert.equal(next, 'PLAN');
  assert.equal(cycles, 1);
});

test('nextPlanLoopState: PLAN_REVIEW CHANGES exceeding max -> ESCALATE', () => {
  const { next, cycles } = nextPlanLoopState('PLAN_REVIEW', 'CHANGES', MAX_CYCLES);
  assert.equal(next, 'ESCALATE');
  assert.equal(cycles, MAX_CYCLES + 1);
});

test('nextPlanLoopState: null verdict -> ESCALATE', () => {
  const { next } = nextPlanLoopState('RESEARCH', null, 0);
  assert.equal(next, 'ESCALATE');
});

// --- buildStagePrompt / prompt interpolation ---

test('buildStagePrompt: PLAN includes issue number, title, body, and VERDICT instruction', () => {
  const prompt = buildStagePrompt('PLAN', { issueNumber: 42, issueTitle: 'Add widget', issueBody: 'Do the thing.' });
  assert.match(prompt, /issue #42/);
  assert.match(prompt, /Add widget/);
  assert.match(prompt, /Do the thing\./);
  assert.match(prompt, /VERDICT: <TOKEN>/);
  assert.match(prompt, /PLAN_READY \| ESCALATE/);
});

test('buildResearchPrompt: includes plan-loop escalation contract', () => {
  const prompt = buildResearchPrompt({ issueNumber: 42, issueTitle: 'Needs plan', issueBody: 'Investigate.' });
  assert.match(prompt, /plan-loop escalation/);
  assert.match(prompt, /裁可/);
  assert.match(prompt, /目標不成立/);
  assert.match(prompt, /依存が既存 open issue と衝突/);
  assert.match(prompt, /未定義の契約/);
  assert.match(prompt, /ロール割当/);
  assert.match(prompt, /規約新設/);
  assert.match(prompt, /実装解が一意でない/);
  assert.match(prompt, /PASS \| ESCALATE/);
});

test('buildResearchPrompt: includes touches grounding only when provided', () => {
  const withoutGrounding = buildResearchPrompt({ issueNumber: 42, issueTitle: 'Needs plan', issueBody: 'Investigate.' });
  assert.doesNotMatch(withoutGrounding, /^## touches grounding$/m);

  const grounding = JSON.stringify({
    status: 'ok',
    issues: [{ issueNumber: 40, precision: 0.5, recall: 0.25, missingActual: ['scripts/x.mjs'] }],
  });
  const withGrounding = buildResearchPrompt({
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    touchesGrounding: grounding,
  });

  assert.match(withGrounding, /^## touches grounding$/m);
  assert.match(withGrounding, /"precision":0\.5/);
  assert.ok(
    withGrounding.indexOf('## touches grounding') > withGrounding.indexOf('## source issue #42'),
    'touches grounding should follow source issue context',
  );
  assert.ok(
    withGrounding.indexOf('plan-loop escalation') > withGrounding.indexOf('## touches grounding'),
    'touches grounding should precede the escalation contract',
  );
});

test('buildPlanPrompt: plan-loop mode requires Title Depends-on Touches', () => {
  const prompt = buildPlanPrompt({
    mode: 'plan-loop',
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    research: 'Facts.',
  });
  assert.match(prompt, /Title:/);
  assert.match(prompt, /Depends-on:/);
  assert.match(prompt, /Touches:/);
  assert.match(prompt, /RESEARCH が提示した全 issue 候補/);
  assert.match(prompt, /起票/);
  assert.match(prompt, /Rejected:/);
  assert.match(prompt, /silent drop 禁止/);
  assert.match(prompt, /plan-loop escalation/);
  assert.match(prompt, /最小変更を発明せず ESCALATE/);
  assert.match(prompt, /PLAN_READY \| ESCALATE/);
});

test('buildPlanReviewPrompt: includes plan-loop escalation contract and PASS/CHANGES', () => {
  const prompt = buildPlanReviewPrompt({
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    research: 'Facts.',
    plan: 'Title: feat\nDepends-on:\nTouches: scripts/x.mjs',
  });
  assert.match(prompt, /PLAN-REVIEW/);
  assert.match(prompt, /裁可事項/);
  assert.match(prompt, /目標不成立/);
  assert.match(prompt, /依存衝突/);
  assert.match(prompt, /処置の無い/);
  assert.match(prompt, /CHANGES/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
});

function assertExternalSpaceSeparationContract(prompt) {
  for (const path of [
    /rubrics\//,
    /\.claude\/skills\//,
    /\.claude\/agents\//,
    /\.claude\/hooks\//,
    /design\/test-failure-playbook\.md/,
  ]) {
    assert.match(prompt, path);
  }
  assert.match(prompt, /内容の当否/);
  assert.match(prompt, /無条件 CHANGES/);
  assert.match(prompt, /当該変更をスライスから外し/);
  assert.match(prompt, /必要なら escalate で監査役に提案せよ/);
}

test('buildPlanReviewPrompt: rejects external-space edits unconditionally', () => {
  const prompt = buildPlanReviewPrompt({
    issueNumber: 42,
    issueTitle: 'Needs plan',
    issueBody: 'Investigate.',
    research: 'Facts.',
    plan: 'Title: feat\nDepends-on: none\nTouches: rubrics/example.mjs',
  });
  assert.match(prompt, /approve しない/);
  assertExternalSpaceSeparationContract(prompt);
});

test('buildStagePrompt: IMPLEMENT includes plan and optional feedback', () => {
  const withoutFeedback = buildStagePrompt('IMPLEMENT', { issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'Do X then Y.' });
  assert.match(withoutFeedback, /Do X then Y\./);
  assert.doesNotMatch(withoutFeedback, /^## 差し戻し指摘/m);

  const withFeedback = buildStagePrompt('IMPLEMENT', {
    issueNumber: 1,
    issueTitle: 'T',
    issueBody: 'B',
    plan: 'Do X then Y.',
    feedback: 'Missing test for edge case.',
  });
  assert.match(withFeedback, /差し戻し指摘/);
  assert.match(withFeedback, /Missing test for edge case\./);
  assert.match(withFeedback, /IMPL_DONE \| ESCALATE/);
});

test('buildImplementPrompt: points implementer to the implement skill and freshness contract', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /\.claude\/skills\/implement\/SKILL\.md/);
  assert.match(prompt, /着手前/);
  assert.match(prompt, /git rebase main/);
  assert.match(prompt, /review handoff 前/);
  assert.match(prompt, /reset --hard main/);
});

test('buildImplementPrompt: impl-loop premise break escalates without replanning', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /前提/);
  assert.match(prompt, /再計画せず ESCALATE/);
});

test('buildImplementPrompt: review feedback with undefined design axis escalates instead of inventing a minimal change', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P', feedback: 'decide new role owner' });
  assert.match(prompt, /未定義の契約/);
  assert.match(prompt, /ロール割当/);
  assert.match(prompt, /規約新設/);
  assert.match(prompt, /実装解が一意でない/);
  assert.match(prompt, /最小変更を発明せず ESCALATE/);
});

test('buildStagePrompt: impl-loop driver-owned escalation conditions are not assigned to the agent', () => {
  const prompts = [
    buildPlanPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B' }),
    buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /driver が機械的に検知・執行/);
    assert.match(prompt, /あなた（agent）は検査しない/);
    assert.match(prompt, /repo の清浄度判定は agent の仕事ではありません/);
    assert.doesNotMatch(prompt, /既存条件（VERDICT 不能・周回超過・NOVEL RED・merge 失敗・main dirty）も ESCALATE です/);
  }
});

test('buildStagePrompt: REVIEW includes plan and VERDICT instruction', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /plan text/);
  assert.match(prompt, /PASS \| CHANGES \| ESCALATE/);
});

test('buildReviewPrompt: asks for comprehensive first-pass review and limits major findings to explicit grounds', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /PLAN と変更全体を一度に照合/);
  assert.match(prompt, /major\/blocker は初回で出し切る/);
  assert.match(prompt, /逐次開示しない/);
  assert.match(prompt, /plan\/rubric\/明文原則違反に限る/);
  assert.match(prompt, /過剰 flag 禁止/);
});

test('buildReviewPrompt: assumes a rebased branch tip as the merged-main artifact', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /rebase 済み/);
  assert.match(prompt, /branch tip/);
  assert.match(prompt, /merged-main 実体/);
  assert.match(prompt, /stale branch を救済しない/);
});

test('buildReviewPrompt: marks external-space diffs as unconditional CHANGES', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /diff が次の外部空間パスに触れていたら/);
  assertExternalSpaceSeparationContract(prompt);
});

test('buildReviewPrompt: includes review history only when provided', () => {
  const withoutHistory = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.doesNotMatch(withoutHistory, /前周までの REVIEW 履歴/);

  const withHistory = buildReviewPrompt({
    issueNumber: 7,
    plan: 'plan text',
    headSha: 'abc123',
    reviewHistory: '- REVIEW #1 verdict=CHANGES',
  });
  assert.match(withHistory, /前周までの REVIEW 履歴/);
  assert.match(withHistory, /REVIEW #1 verdict=CHANGES/);
  assert.match(withHistory, /前言と矛盾する新指摘/);
  assert.match(withHistory, /撤回/);
  assert.match(withHistory, /理由/);
});

test('buildStagePrompt: VERIFY includes VERDICT instruction', () => {
  const prompt = buildStagePrompt('VERIFY', { issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /GREEN \| RED \| ESCALATE/);
});

test('buildVerifyPrompt: assumes a rebased branch tip as the merged-main artifact', () => {
  const prompt = buildVerifyPrompt({ issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /rebase 済み/);
  assert.match(prompt, /branch tip/);
  assert.match(prompt, /merged-main 実体/);
  assert.match(prompt, /stale branch を救済しない/);
});

// --- receipt issuance is the driver's job, not the prompt's (regression guard) ---
// The driver stamps REVIEW/VERIFY receipts itself (buildReceiptArgs) because an
// agent-issued `LATHE_AGENT=... node scripts/receipt.mjs ...` command silently
// fails the Bash allowlist (env-prefixed commands don't prefix-match
// `Bash(node scripts/receipt.mjs *)`). Prompts must never re-introduce that
// instruction.

test('buildStagePrompt: REVIEW prompt does not instruct the agent to issue a receipt', () => {
  const prompt = buildStagePrompt('REVIEW', { issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

test('buildStagePrompt: VERIFY prompt does not instruct the agent to issue a receipt', () => {
  const prompt = buildStagePrompt('VERIFY', { issueNumber: 7, headSha: 'def456' });
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

// --- F1: IMPLEMENT prompt に役割契約（worktree 内・ネスト禁止）---

test('buildImplementPrompt: contains worktree role contract — in worktree inner-issue-N', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /inner-issue-1/);
  assert.match(prompt, /worktree/);
});

test('buildImplementPrompt: forbids nested subagent spawn', () => {
  const prompt = buildImplementPrompt({ issueNumber: 1, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt, /subagent/);
  assert.match(prompt, /spawn しない/);
});

test('buildImplementPrompt: worktree name reflects issueNumber', () => {
  const prompt42 = buildImplementPrompt({ issueNumber: 42, issueTitle: 'T', issueBody: 'B', plan: 'P' });
  assert.match(prompt42, /inner-issue-42/);
  assert.match(prompt42, /inner\/issue-42/);
});

// --- F3: REVIEW/VERIFY prompt に receipt 非発行契約 ---

test('buildReviewPrompt: instructs agent not to issue receipt', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /発行しない/);
  // 既存ガードも維持（receipt.mjs / LATHE_AGENT を含まない）
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

test('buildVerifyPrompt: instructs agent not to issue receipt', () => {
  const prompt = buildVerifyPrompt({ issueNumber: 7, headSha: 'def456' });
  assert.match(prompt, /発行しない/);
  // 既存ガードも維持
  assert.doesNotMatch(prompt, /receipt\.mjs/);
  assert.doesNotMatch(prompt, /LATHE_AGENT/);
});

// --- I1: PLAN prompt に impact-scaled rigor ---

test('buildPlanPrompt: contains impact-scaled rigor hint', () => {
  const prompt = buildPlanPrompt({ issueNumber: 42, issueTitle: 'T', issueBody: 'B' });
  assert.match(prompt, /軽量 plan/);
});

// --- I2: REVIEW prompt に inline diff 指定 ---

test('buildReviewPrompt: specifies inline git diff main...HEAD', () => {
  const prompt = buildReviewPrompt({ issueNumber: 7, plan: 'plan text', headSha: 'abc123' });
  assert.match(prompt, /git diff main\.\.\.HEAD/);
  // diff 収集の subagent 委譲禁止も含む
  assert.match(prompt, /subagent に委譲しない/);
});

test('buildStagePrompt: TRIAGE includes verifyResult', () => {
  const prompt = buildStagePrompt('TRIAGE', { issueNumber: 7, verifyResult: 'RED: unit — assertion failed at x.test.mjs:10' });
  assert.match(prompt, /assertion failed at x\.test\.mjs:10/);
  assert.match(prompt, /KNOWN \| NOVEL \| ESCALATE/);
});

test('buildTriagePrompt: Codex sandbox EPERM is escalated, not returned as KNOWN', () => {
  const prompt = buildTriagePrompt({ issueNumber: 7, verifyResult: 'RED: tsc — EPERM writing .tsbuildinfo' });
  assert.match(prompt, /P4/);
  assert.match(prompt, /Codex sandbox EPERM/);
  assert.match(prompt, /VERDICT: ESCALATE/);
  assert.match(prompt, /VERDICT: KNOWN` で IMPLEMENT に戻してはいけません/);
});

test('implementer agent: ambiguous requirements choose smallest change except undefined design axis from feedback escalates', () => {
  const agent = readFileSync(new URL('../.claude/agents/implementer.md', import.meta.url), 'utf8');
  assert.match(agent, /choose the smallest compatible change/);
  assert.match(agent, /差し戻し/);
  assert.match(agent, /設計軸が未定義/);
  assert.match(agent, /ESCALATE/);
});

test('implementer agent and skill require main freshness before implementation and review handoff', () => {
  const agent = readFileSync(new URL('../.claude/agents/implementer.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../.claude/skills/implement/SKILL.md', import.meta.url), 'utf8');
  for (const text of [agent, skill]) {
    assert.match(text, /git rebase main/);
    assert.match(text, /着手前/);
    assert.match(text, /review handoff 前/);
    assert.match(text, /ESCALATE/);
  }
  assert.match(skill, /git reset --hard main/);
  assert.match(skill, /成果物を消す運用は禁止/);
});

test('review and verify skills assume a rebased branch tip rather than rescuing stale branches', () => {
  const reviewSkill = readFileSync(new URL('../.claude/skills/review/SKILL.md', import.meta.url), 'utf8');
  const verifySkill = readFileSync(new URL('../.claude/skills/verify/SKILL.md', import.meta.url), 'utf8');
  for (const text of [reviewSkill, verifySkill]) {
    assert.match(text, /rebase 済み/);
    assert.match(text, /branch tip/);
    assert.match(text, /merged-main 実体/);
    assert.match(text, /stale branch を救済しない/);
  }
});

test('reviewer agent and skill review branch diff, not uncommitted diff handoff', () => {
  const reviewerAgent = readFileSync(new URL('../.claude/agents/reviewer.md', import.meta.url), 'utf8');
  const reviewSkill = readFileSync(new URL('../.claude/skills/review/SKILL.md', import.meta.url), 'utf8');
  for (const text of [reviewerAgent, reviewSkill]) {
    assert.doesNotMatch(text, /未コミット|uncommitted/);
    assert.match(text, /branch tip/);
    assert.match(text, /git diff main\.\.\.HEAD/);
    assert.match(text, /merged-main 実体/);
  }
});

test('buildStagePrompt: unknown stage throws', () => {
  assert.throws(() => buildStagePrompt('BOGUS', {}), /unknown stage/);
});

test('direct builder exports match buildStagePrompt dispatch', () => {
  const ctx = { issueNumber: 5, issueTitle: 'T', issueBody: 'B', plan: 'P', headSha: 'sha1', verifyResult: 'V' };
  assert.equal(buildResearchPrompt(ctx), buildStagePrompt('RESEARCH', ctx));
  assert.equal(buildPlanPrompt(ctx), buildStagePrompt('PLAN', ctx));
  assert.equal(buildPlanReviewPrompt(ctx), buildStagePrompt('PLAN_REVIEW', ctx));
  assert.equal(buildImplementPrompt(ctx), buildStagePrompt('IMPLEMENT', ctx));
  assert.equal(buildReviewPrompt(ctx), buildStagePrompt('REVIEW', ctx));
  assert.equal(buildVerifyPrompt(ctx), buildStagePrompt('VERIFY', ctx));
  assert.equal(buildTriagePrompt(ctx), buildStagePrompt('TRIAGE', ctx));
});

// --- stagePermissions ---

test('stagePermissions: IMPLEMENT is acceptEdits (edit-capable)', () => {
  const { agent, permissionMode } = stagePermissions('IMPLEMENT');
  assert.equal(agent, 'implementer');
  assert.equal(permissionMode, 'acceptEdits');
});

test('stagePermissions: IMPLEMENT allows blanket Bash (worktree cwd + role contract + main-dirty backstop + merge gate)', () => {
  const { allowedTools } = stagePermissions('IMPLEMENT');
  assert.deepEqual(allowedTools, ['Read', 'Grep', 'Glob', 'Bash']);
});

test('stagePermissions: RESEARCH allowedTools stay read-only and unchanged by grounding injection', () => {
  const { allowedTools } = stagePermissions('RESEARCH');
  assert.deepEqual(allowedTools, [
    'Read',
    'Grep',
    'Glob',
    'Bash(git *)',
    'Bash(gh issue view *)',
    'Bash(gh issue list *)',
  ]);
});

test('stagePermissions: no stage ever uses bypassPermissions or --bare', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.notEqual(permissionMode, 'bypassPermissions');
    assert.notEqual(permissionMode, '--bare');
  }
});

test('stagePermissions: read-only stages use dontAsk, never bypassPermissions', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const { permissionMode } = stagePermissions(stage);
    assert.equal(permissionMode, 'dontAsk');
    assert.notEqual(permissionMode, 'bypassPermissions');
  }
});

test('stagePermissions: plan-loop RESEARCH uses researcher and PLAN_REVIEW uses reviewer (ADR 0016: author/approver separation)', () => {
  assert.equal(stagePermissions('RESEARCH').agent, 'researcher');
  assert.equal(stagePermissions('PLAN_REVIEW').agent, 'reviewer');
});

test('stagePermissions: VERIFY allows blanket Bash (needs to run gates; narrow allowlists structurally conflict with verification idioms, #36/#44)', () => {
  const { allowedTools } = stagePermissions('VERIFY');
  assert.ok(allowedTools.includes('Bash'));
});

test('stagePermissions: unknown stage throws', () => {
  assert.throws(() => stagePermissions('BOGUS'), /unknown stage/);
});

// --- stageCwd ---

test('stageCwd: PLAN runs at repo root', () => {
  assert.equal(stageCwd('PLAN', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
});

test('stageCwd: plan-loop read stages run at repo root', () => {
  assert.equal(stageCwd('RESEARCH', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
  assert.equal(stageCwd('PLAN_REVIEW', '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo');
});

test('stageCwd: implementation stages run in the worktree', () => {
  for (const stage of ['IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    assert.equal(stageCwd(stage, '/repo', '/repo/.claude/worktrees/inner-issue-1'), '/repo/.claude/worktrees/inner-issue-1');
  }
});

test('stageRequiresFreshMainRebase: IMPLEMENT and REVIEW rebase before spawning agents', () => {
  assert.equal(stageRequiresFreshMainRebase('IMPLEMENT'), true);
  assert.equal(stageRequiresFreshMainRebase('REVIEW'), true);
  assert.equal(stageRequiresFreshMainRebase('VERIFY'), false);
  assert.equal(stageRequiresFreshMainRebase('TRIAGE'), false);
  assert.equal(stageRequiresFreshMainRebase('PLAN'), false);
});

// --- manifest entry / manifest shape ---

test('buildManifestEntry: fills defaults for missing optional fields', () => {
  const entry = buildManifestEntry({
    stage: 'PLAN',
    sessionId: 'sess-1',
    verdict: 'PLAN_READY',
    backendCostUsd: 0.05,
    backendCostSource: 'claude.result.total_cost_usd',
  });
  assert.equal(entry.stage, 'PLAN');
  assert.equal(entry.session_id, 'sess-1');
  assert.equal(entry.verdict, 'PLAN_READY');
  assert.equal(entry.backend_cost_usd, 0.05);
  assert.equal(entry.backend_cost_source, 'claude.result.total_cost_usd');
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
  assert.equal(entry.duration_ms, null);
  assert.ok(entry.ts);
});

test('buildManifestEntry: null sessionId/verdict/backend cost -> null fields (not undefined)', () => {
  const entry = buildManifestEntry({
    stage: 'PLAN',
    sessionId: null,
    verdict: null,
    backendCostUsd: null,
    backendCostSource: null,
  });
  assert.equal(entry.session_id, null);
  assert.equal(entry.verdict, null);
  assert.equal(entry.backend_cost_usd, null);
  assert.equal(entry.backend_cost_source, null);
  assert.equal(Object.hasOwn(entry, 'backend_model'), false);
  assert.equal(Object.hasOwn(entry, 'backend_token_usage'), false);
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
});

test('buildManifestEntry: backend field is recorded when provided (ADR 0014)', () => {
  const entry = buildManifestEntry({
    stage: 'PLAN',
    sessionId: 's1',
    verdict: 'PLAN_READY',
    backendCostUsd: 0.01,
    backendCostSource: 'codex.jsonl.explicit_cost',
    backend: 'codex',
  });
  assert.equal(entry.backend, 'codex');
});

test('buildManifestEntry: records codex model and token usage without legacy cost_usd', () => {
  const tokenUsage = {
    input_tokens: 19943,
    cached_input_tokens: 4992,
    output_tokens: 177,
    reasoning_output_tokens: 170,
  };
  const entry = buildManifestEntry({
    stage: 'IMPLEMENT',
    sessionId: '019f2492-1a96-7e81-9c7a-484a11d135ef',
    verdict: 'IMPL_DONE',
    backendCostUsd: 0.02108125,
    backendCostSource: 'codex.jsonl.turn.completed.usage',
    backend: 'codex',
    backendModel: 'gpt-5-codex',
    backendTokenUsage: tokenUsage,
  });

  assert.equal(entry.backend_model, 'gpt-5-codex');
  assert.deepEqual(entry.backend_token_usage, tokenUsage);
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
});

test('buildManifestEntry: records observed codex usage evidence when model is unavailable', () => {
  const tokenUsage = {
    input_tokens: 19943,
    cached_input_tokens: 4992,
    output_tokens: 177,
    reasoning_output_tokens: 170,
  };
  const entry = buildManifestEntry({
    stage: 'IMPLEMENT',
    sessionId: '019f2492-1a96-7e81-9c7a-484a11d135ef',
    verdict: 'IMPL_DONE',
    backendCostUsd: null,
    backendCostSource: 'codex.jsonl.turn.completed.usage.unpriced',
    backend: 'codex',
    backendModel: null,
    backendTokenUsage: tokenUsage,
  });

  assert.equal(entry.backend_cost_usd, null);
  assert.equal(entry.backend_cost_source, 'codex.jsonl.turn.completed.usage.unpriced');
  assert.equal(Object.hasOwn(entry, 'backend_model'), false);
  assert.deepEqual(entry.backend_token_usage, tokenUsage);
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
});

test('buildManifestEntry: backend omitted -> null (backward compatible)', () => {
  const entry = buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', backendCostUsd: 0.01 });
  assert.equal(entry.backend, null);
});

test('buildManifestEntry: records duration even when cost is null', () => {
  const entry = buildManifestEntry({
    stage: 'VERIFY',
    sessionId: 'exec-session-123',
    verdict: 'GREEN',
    backendCostUsd: null,
    backendCostSource: null,
    durationMs: 321,
    backend: 'codex',
  });
  assert.equal(entry.backend_cost_usd, null);
  assert.equal(entry.backend_cost_source, null);
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
  assert.equal(entry.duration_ms, 321);
});

test('buildManifestEntry: accepts legacy costUsd input as backend cost without emitting cost_usd', () => {
  const entry = buildManifestEntry({
    stage: 'PLAN',
    sessionId: 's1',
    verdict: 'PLAN_READY',
    costUsd: 0.11,
  });

  assert.equal(entry.backend_cost_usd, 0.11);
  assert.equal(entry.backend_cost_source, null);
  assert.equal(Object.hasOwn(entry, 'cost_usd'), false);
});

test('backendCostSourceForEnvelope: labels backend envelope cost sources', () => {
  assert.equal(
    backendCostSourceForEnvelope({ backend: 'claude', total_cost_usd: 0.72 }),
    'claude.result.total_cost_usd',
  );
  assert.equal(
    backendCostSourceForEnvelope({ backend: 'codex', total_cost_usd: 0.31 }),
    'codex.jsonl.explicit_cost',
  );
  assert.equal(
    backendCostSourceForEnvelope({ backend: 'codex', total_cost_usd: null }),
    null,
  );
  assert.equal(
    backendCostSourceForEnvelope({ backend: 'codex', total_cost_usd: null, backend_cost_source: 'codex.jsonl.turn.completed.usage.unpriced' }),
    'codex.jsonl.turn.completed.usage.unpriced',
  );
});

test('runStage: claude backend passes LATHE_STAGE env for the stage', () => {
  const calls = [];
  const envelope = runStage('VERIFY', 'verify prompt', process.cwd(), null, 'claude', {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({
          session_id: 'claude-session',
          result: 'verified\nVERDICT: GREEN',
          total_cost_usd: 0.01,
        }),
        stderr: '',
      };
    },
  });

  assert.equal(envelope.backend, 'claude');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].options.env.LATHE_STAGE, 'VERIFY');
});

test('runStage: codex backend does not set LATHE_STAGE env', () => {
  const calls = [];
  const envelope = runStage('TRIAGE', 'triage prompt', process.cwd(), null, 'codex', {
    spawnSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(envelope.backend, 'codex');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
  assert.equal(Object.hasOwn(calls[0].options, 'env'), false);
});

test('runStageWithUnparsableRetry: records UNPARSABLE then returns successful retry verdict', () => {
  const results = [
    'still checking logs without a verdict',
    'verification passed\nVERDICT: GREEN',
  ];
  const entries = [];
  let calls = 0;

  const outcome = runStageWithUnparsableRetry({
    runAttempt: () => {
      const result = results[calls];
      calls += 1;
      return {
        envelope: { session_id: `s-${calls}`, result, total_cost_usd: null, backend: 'codex' },
        durationMs: calls,
        headSha: 'sha-verify',
      };
    },
    recordAttempt: ({ envelope, manifestVerdict, durationMs, headSha }) => {
      entries.push(buildManifestEntry({
        stage: 'VERIFY',
        sessionId: envelope.session_id,
        verdict: manifestVerdict,
        backendCostUsd: envelope.total_cost_usd,
        durationMs,
        backend: envelope.backend,
        headSha,
        resultText: envelope.result,
      }));
    },
  });

  assert.equal(outcome.verdict, 'GREEN');
  assert.equal(calls, 2);
  assert.deepEqual(entries.map((entry) => entry.verdict), ['UNPARSABLE', 'GREEN']);
  assert.deepEqual(entries.map((entry) => entry.result_text), results);
});

test('runStageWithUnparsableRetry: stops after one unparsable retry', () => {
  const entries = [];
  let calls = 0;

  const outcome = runStageWithUnparsableRetry({
    runAttempt: () => {
      calls += 1;
      return {
        envelope: { session_id: `s-${calls}`, result: `attempt ${calls} has no verdict`, total_cost_usd: null, backend: 'codex' },
        durationMs: calls,
        headSha: 'sha-verify',
      };
    },
    recordAttempt: ({ envelope, manifestVerdict }) => {
      entries.push(buildManifestEntry({
        stage: 'VERIFY',
        sessionId: envelope.session_id,
        verdict: manifestVerdict,
        backendCostUsd: envelope.total_cost_usd,
        backend: envelope.backend,
        headSha: 'sha-verify',
        resultText: envelope.result,
      }));
    },
  });

  assert.equal(outcome.verdict, null);
  assert.equal(calls, 2);
  assert.deepEqual(entries.map((entry) => entry.verdict), ['UNPARSABLE', 'UNPARSABLE']);
});

test('runStageWithUnparsableRetry: does not retry regular verdicts', () => {
  for (const token of ['ESCALATE', 'RED', 'CHANGES']) {
    let calls = 0;
    const outcome = runStageWithUnparsableRetry({
      runAttempt: () => {
        calls += 1;
        return {
          envelope: { session_id: `s-${token}`, result: `finished\nVERDICT: ${token}`, total_cost_usd: null, backend: 'codex' },
          durationMs: 1,
          headSha: 'sha-stage',
        };
      },
      recordAttempt: () => {},
    });

    assert.equal(outcome.verdict, token);
    assert.equal(calls, 1, `${token} should not retry`);
  }
});

test('buildManifestEntry: records resume fields when provided', () => {
  const entry = buildManifestEntry({
    stage: 'IMPLEMENT',
    sessionId: 'exec-session-123',
    verdict: 'IMPL_DONE',
    costUsd: null,
    headSha: 'abc123',
    resultText: 'implementation notes\nVERDICT: IMPL_DONE',
  });
  assert.equal(entry.head_sha, 'abc123');
  assert.equal(entry.result_text, 'implementation notes\nVERDICT: IMPL_DONE');
});

test('buildManifest: wraps issue number and stages array', () => {
  const stages = [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.1 })];
  const manifest = buildManifest(25, stages);
  assert.equal(manifest.issue, 25);
  assert.equal(manifest.stages.length, 1);
  assert.equal(manifest.stages[0].stage, 'PLAN');
});

// --- taskUnitToSlug (ADR 0025 TASK-1.1) ---

test('taskUnitToSlug: lowercases and hyphenates task ids', () => {
  assert.equal(taskUnitToSlug('TASK-1'), 'task-1');
  assert.equal(taskUnitToSlug('TASK-1.2'), 'task-1-2');
  assert.equal(taskUnitToSlug('TASK-1.1'), 'task-1-1');
});

test('taskUnitToSlug: collapses runs of non-alphanumeric chars and trims edges', () => {
  assert.equal(taskUnitToSlug('TASK--1..2'), 'task-1-2');
  assert.equal(taskUnitToSlug('-TASK-1-'), 'task-1');
});

// --- buildManifest: task unit shape (ADR 0025 TASK-1.1) ---

test('buildManifest: task unit writes unit{kind,id} and omits issue field', () => {
  const stages = [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.1 })];
  const manifest = buildManifest(null, stages, { unit: { kind: 'task', id: 'TASK-1' } });
  assert.deepEqual(manifest.unit, { kind: 'task', id: 'TASK-1' });
  assert.equal('issue' in manifest, false);
  assert.equal(manifest.stages.length, 1);
  assert.equal(manifest.stages[0].stage, 'PLAN');
});

test('buildManifest: issue-loop call sites are unaffected by the task unit branch', () => {
  const stages = [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.1 })];
  const manifest = buildManifest(7, stages);
  assert.equal(manifest.issue, 7);
  assert.equal('unit' in manifest, false);
});

// --- manifestPathFor: task unit shape (ADR 0025 TASK-1.1) ---

test('manifestPathFor: task unit resolves to .lathe/runs/task-<slug>.json', () => {
  const p = manifestPathFor({ kind: 'task', id: 'TASK-1' });
  assert.match(p, /\.lathe\/runs\/task-1\.json$/);
});

test('manifestPathFor: task unit with dotted id slugifies the dot', () => {
  const p = manifestPathFor({ kind: 'task', id: 'TASK-1.2' });
  assert.match(p, /\.lathe\/runs\/task-1-2\.json$/);
});

test('manifestPathFor: issue-loop call sites are unaffected by the task unit branch', () => {
  const p = manifestPathFor(25);
  assert.match(p, /\.lathe\/runs\/issue-25\.json$/);
});

// --- readManifestStages ---

function makeTempDir(testId) {
  const dir = join(tmpdir(), `lathe-inner-loop-test-${testId}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('readManifestStages: missing file -> []', () => {
  const dir = makeTempDir('missing');
  const result = readManifestStages(join(dir, 'issue-1.json'));
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: malformed JSON -> []', () => {
  const dir = makeTempDir('malformed');
  const path = join(dir, 'issue-1.json');
  writeFileSync(path, '{not valid json', 'utf8');
  const result = readManifestStages(path);
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: valid manifest -> returns stages array', () => {
  const dir = makeTempDir('valid');
  const path = join(dir, 'issue-1.json');
  const manifest = buildManifest(1, [buildManifestEntry({ stage: 'PLAN', sessionId: 's1', verdict: 'PLAN_READY', costUsd: 0.01 })]);
  writeFileSync(path, JSON.stringify(manifest), 'utf8');
  const result = readManifestStages(path);
  assert.equal(result.length, 1);
  assert.equal(result[0].stage, 'PLAN');
  rmSync(dir, { recursive: true, force: true });
});

test('readManifestStages: stages not an array -> []', () => {
  const dir = makeTempDir('bad-shape');
  const path = join(dir, 'issue-1.json');
  writeFileSync(path, JSON.stringify({ issue: 1, stages: 'oops' }), 'utf8');
  const result = readManifestStages(path);
  assert.deepEqual(result, []);
  rmSync(dir, { recursive: true, force: true });
});

// --- review history transport / escalation summary ---

test('collectReviewHistory: extracts all REVIEW entries with verdict, head, ts, excerpt, and contradiction markers', () => {
  const history = collectReviewHistory([
    buildManifestEntry({ stage: 'PLAN', sessionId: 's-plan', verdict: 'PLAN_READY', costUsd: 0.01, resultText: 'plan' }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: plan と違う\nVERDICT: CHANGES',
    }),
    buildManifestEntry({ stage: 'IMPLEMENT', sessionId: 's-impl', verdict: 'IMPL_DONE', costUsd: 0.03, headSha: 'sha-impl', resultText: 'done' }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'CHANGES',
      costUsd: 0.04,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: '前言と矛盾するため撤回が必要\nVERDICT: CHANGES',
    }),
  ]);

  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => entry.ordinal), [1, 2]);
  assert.equal(history[0].verdict, 'CHANGES');
  assert.equal(history[0].headSha, 'sha-review-1');
  assert.equal(history[0].ts, '2026-07-02T00:00:00.000Z');
  assert.match(history[0].excerpt, /major: plan と違う/);
  assert.equal(history[0].hasContradictionMarker, false);
  assert.equal(history[1].hasContradictionMarker, true);
});

test('buildReviewHistorySummary: returns empty without REVIEW entries and a prompt-ready summary with REVIEW entries', () => {
  assert.equal(buildReviewHistorySummary([]), '');

  const summary = buildReviewHistorySummary([
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: first issue\nVERDICT: CHANGES',
    }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'PASS',
      costUsd: 0.03,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: 'withdraw previous concern\nVERDICT: PASS',
    }),
  ]);

  assert.match(summary, /REVIEW #1/);
  assert.match(summary, /verdict: CHANGES/);
  assert.match(summary, /head_sha: sha-review-1/);
  assert.match(summary, /major: first issue/);
  assert.match(summary, /REVIEW #2/);
  assert.match(summary, /contradiction_marker: yes/);
});

test('buildEscalationMarkdown: includes all REVIEW rounds, not only the final stage excerpt', () => {
  const reviewHistory = collectReviewHistory([
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-1',
      verdict: 'CHANGES',
      costUsd: 0.02,
      ts: '2026-07-02T00:00:00.000Z',
      headSha: 'sha-review-1',
      resultText: 'major: first issue\nVERDICT: CHANGES',
    }),
    buildManifestEntry({
      stage: 'REVIEW',
      sessionId: 's-review-2',
      verdict: 'ESCALATE',
      costUsd: 0.03,
      ts: '2026-07-02T00:10:00.000Z',
      headSha: 'sha-review-2',
      resultText: '前言と矛盾\nVERDICT: ESCALATE',
    }),
  ]);
  const markdown = buildEscalationMarkdown({
    issueNumber: 48,
    stage: 'REVIEW',
    verdict: 'ESCALATE',
    ts: '2026-07-02T00:11:00.000Z',
    resultExcerpt: 'final reviewer excerpt',
    reviewHistory,
  });

  assert.match(markdown, /# escalation — issue #48/);
  assert.match(markdown, /## REVIEW verdict history/);
  assert.match(markdown, /REVIEW #1/);
  assert.match(markdown, /major: first issue/);
  assert.match(markdown, /REVIEW #2/);
  assert.match(markdown, /contradiction_marker: yes/);
  assert.match(markdown, /final reviewer excerpt/);
});

// --- resume decision ---

const cleanWorktree = (headSha = 'sha-1') => ({
  exists: true,
  branchMatches: true,
  clean: true,
  headSha,
});

test('decideResumeState: PLAN_READY + IMPL_DONE resumes at REVIEW and skips completed stages', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-1',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
    ],
    worktree: cleanWorktree('sha-1'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'REVIEW');
  assert.equal(result.plan, 'plan text\nVERDICT: PLAN_READY');
  assert.deepEqual(result.skipped, ['PLAN', 'IMPLEMENT']);
  assert.deepEqual(result.receiptsToStamp, []);
});

test('decideResumeState: REVIEW PASS resumes at VERIFY and restamps review receipt', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-2',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-2',
        resultText: 'review ok\nVERDICT: PASS',
      }),
    ],
    worktree: cleanWorktree('sha-2'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'VERIFY');
  assert.deepEqual(result.receiptsToStamp, [{ stage: 'REVIEW', headSha: 'sha-2', verdict: 'PASS' }]);
});

test('decideResumeState: VERIFY GREEN resumes at MERGE and restamps merge receipts', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-3',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-3',
        resultText: 'review ok\nVERDICT: PASS',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify',
        verdict: 'GREEN',
        costUsd: 0.04,
        headSha: 'sha-3',
        resultText: 'green\nVERDICT: GREEN',
      }),
    ],
    worktree: cleanWorktree('sha-3'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'MERGE');
  assert.deepEqual(result.receiptsToStamp, [
    { stage: 'REVIEW', headSha: 'sha-3', verdict: 'PASS' },
    { stage: 'VERIFY', headSha: 'sha-3', verdict: 'GREEN' },
  ]);
});

test('decideResumeState: UNPARSABLE attempt followed by success resumes after successful retry', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-3',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-3',
        resultText: 'review ok\nVERDICT: PASS',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify-1',
        verdict: 'UNPARSABLE',
        costUsd: 0.04,
        headSha: 'sha-3',
        resultText: 'waiting for background task completion',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify-2',
        verdict: 'GREEN',
        costUsd: 0.05,
        headSha: 'sha-3',
        resultText: 'green\nVERDICT: GREEN',
      }),
    ],
    worktree: cleanWorktree('sha-3'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'MERGE');
  assert.deepEqual(result.skipped, ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY']);
  assert.deepEqual(result.receiptsToStamp, [
    { stage: 'REVIEW', headSha: 'sha-3', verdict: 'PASS' },
    { stage: 'VERIFY', headSha: 'sha-3', verdict: 'GREEN' },
  ]);
});

test('decideResumeState: IMPLEMENT UNPARSABLE head does not pin resume after successful retry', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl-1',
        verdict: 'UNPARSABLE',
        costUsd: 0.02,
        headSha: 'sha-unparsable-attempt',
        resultText: 'still running without final verdict',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl-2',
        verdict: 'IMPL_DONE',
        costUsd: 0.03,
        headSha: 'sha-successful-retry',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
    ],
    worktree: cleanWorktree('sha-successful-retry'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'REVIEW');
  assert.deepEqual(result.skipped, ['PLAN', 'IMPLEMENT']);
});

test('decideResumeState: final UNPARSABLE attempt resumes the same stage for retry', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-3',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-3',
        resultText: 'review ok\nVERDICT: PASS',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify-1',
        verdict: 'UNPARSABLE',
        costUsd: 0.04,
        headSha: 'sha-3',
        resultText: 'waiting for background task completion',
      }),
    ],
    worktree: cleanWorktree('sha-3'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'VERIFY');
  assert.deepEqual(result.skipped, ['PLAN', 'IMPLEMENT', 'REVIEW']);
  assert.deepEqual(result.receiptsToStamp, [
    { stage: 'REVIEW', headSha: 'sha-3', verdict: 'PASS' },
  ]);
});

test('decideResumeState: two consecutive UNPARSABLE attempts are not resumable for another retry', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-3',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'PASS',
        costUsd: 0.03,
        headSha: 'sha-3',
        resultText: 'review ok\nVERDICT: PASS',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify-1',
        verdict: 'UNPARSABLE',
        costUsd: 0.04,
        headSha: 'sha-3',
        resultText: 'first attempt has no verdict',
      }),
      buildManifestEntry({
        stage: 'VERIFY',
        sessionId: 's-verify-2',
        verdict: 'UNPARSABLE',
        costUsd: 0.05,
        headSha: 'sha-3',
        resultText: 'retry also has no verdict',
      }),
    ],
    worktree: cleanWorktree('sha-3'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unparsable retry exhausted for VERIFY/);
});

test('decideResumeState: REVIEW CHANGES restores feedback and resumes at IMPLEMENT', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'sha-4',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
      buildManifestEntry({
        stage: 'REVIEW',
        sessionId: 's-review',
        verdict: 'CHANGES',
        costUsd: 0.03,
        headSha: 'sha-4',
        resultText: 'fix this\nVERDICT: CHANGES',
      }),
    ],
    worktree: cleanWorktree('sha-4'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENT');
  assert.equal(result.cycles, 1);
  assert.equal(result.feedback, 'fix this\nVERDICT: CHANGES');
});

test('decideResumeState: ESCALATE verdict reruns the same stage instead of skipping it', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'ESCALATE',
        costUsd: 0.02,
        headSha: 'sha-5',
        resultText: 'blocked\nVERDICT: ESCALATE',
      }),
    ],
    worktree: cleanWorktree('sha-5'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENT');
  assert.deepEqual(result.skipped, ['PLAN']);
});

test('decideResumeState: legacy PLAN_READY without result_text is not resumable', () => {
  const result = decideResumeState({
    stages: [
      {
        stage: 'PLAN',
        session_id: 's-plan',
        verdict: 'PLAN_READY',
        cost_usd: 0.01,
        duration_ms: 1,
        ts: '2026-07-02T00:00:00.000Z',
        backend: 'codex',
      },
    ],
    worktree: cleanWorktree('sha-6'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /legacy manifest lacks result_text/);
});

test('decideResumeState: legacy cost_usd with result_text remains resumable', () => {
  const result = decideResumeState({
    stages: [
      {
        stage: 'PLAN',
        session_id: 's-plan',
        verdict: 'PLAN_READY',
        cost_usd: 0.01,
        duration_ms: 1,
        ts: '2026-07-02T00:00:00.000Z',
        backend: 'claude',
        result_text: 'plan text\nVERDICT: PLAN_READY',
      },
    ],
    worktree: cleanWorktree('sha-legacy'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENT');
  assert.equal(result.plan, 'plan text\nVERDICT: PLAN_READY');
});

test('decideResumeState: missing worktree is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
    ],
    worktree: { exists: false, branchMatches: false, clean: false, headSha: null },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing worktree/);
});

test('decideResumeState: dirty worktree is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
    ],
    worktree: { exists: true, branchMatches: true, clean: false, headSha: 'sha-7' },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /dirty worktree/);
});

test('decideResumeState: sha mismatch is not resumable', () => {
  const result = decideResumeState({
    stages: [
      buildManifestEntry({
        stage: 'PLAN',
        sessionId: 's-plan',
        verdict: 'PLAN_READY',
        costUsd: 0.01,
        resultText: 'plan text\nVERDICT: PLAN_READY',
      }),
      buildManifestEntry({
        stage: 'IMPLEMENT',
        sessionId: 's-impl',
        verdict: 'IMPL_DONE',
        costUsd: 0.02,
        headSha: 'manifest-sha',
        resultText: 'implemented\nVERDICT: IMPL_DONE',
      }),
    ],
    worktree: cleanWorktree('actual-sha'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /sha mismatch/);
});

// --- buildReceiptArgs: driver stamps REVIEW/VERIFY receipts itself ---

test('buildReceiptArgs: REVIEW + PASS builds review receipt argv with reviewer agent', () => {
  const result = buildReceiptArgs('REVIEW', 'abc123', 'PASS');
  assert.equal(result.command, 'node');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'review', 'abc123', 'PASS']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'reviewer' });
});

test('buildReceiptArgs: REVIEW + CHANGES builds review receipt argv', () => {
  const result = buildReceiptArgs('REVIEW', 'abc123', 'CHANGES');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'review', 'abc123', 'CHANGES']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'reviewer' });
});

test('buildReceiptArgs: VERIFY + GREEN builds verify receipt argv with verifier agent', () => {
  const result = buildReceiptArgs('VERIFY', 'def456', 'GREEN');
  assert.equal(result.command, 'node');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'verify', 'def456', 'GREEN']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'verifier' });
});

test('buildReceiptArgs: VERIFY + RED builds verify receipt argv', () => {
  const result = buildReceiptArgs('VERIFY', 'def456', 'RED');
  assert.deepEqual(result.args, ['scripts/receipt.mjs', 'verify', 'def456', 'RED']);
  assert.deepEqual(result.env, { LATHE_AGENT: 'verifier' });
});

test('buildReceiptArgs: REVIEW + ESCALATE -> null (not a receipt-eligible verdict)', () => {
  assert.equal(buildReceiptArgs('REVIEW', 'abc123', 'ESCALATE'), null);
});

test('buildReceiptArgs: VERIFY + ESCALATE -> null (not a receipt-eligible verdict)', () => {
  assert.equal(buildReceiptArgs('VERIFY', 'def456', 'ESCALATE'), null);
});

test('buildReceiptArgs: non-receipt stages (PLAN/IMPLEMENT/TRIAGE) -> null', () => {
  for (const stage of ['RESEARCH', 'PLAN', 'PLAN_REVIEW', 'IMPLEMENT', 'TRIAGE']) {
    assert.equal(buildReceiptArgs(stage, 'abc123', 'PLAN_READY'), null, `stage=${stage} should not be receipt-eligible`);
  }
});

// --- tailLines: merge escalation output capture ---

test('tailLines: returns last n lines (default 30)', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const result = tailLines(lines.join('\n'));
  const resultLines = result.split('\n');
  assert.equal(resultLines.length, 30);
  assert.equal(resultLines[0], 'line-10');
  assert.equal(resultLines[29], 'line-39');
});

test('tailLines: shorter input returned unchanged (trimmed)', () => {
  assert.equal(tailLines('  a\nb\nc  '), 'a\nb\nc');
});

test('tailLines: custom n', () => {
  const result = tailLines('a\nb\nc\nd', 2);
  assert.equal(result, 'c\nd');
});

test('tailLines: null/undefined -> empty string', () => {
  assert.equal(tailLines(null), '');
  assert.equal(tailLines(undefined), '');
});

// --- P4: non-implementable Codex sandbox EPERM triage ---

test('isCodexSandboxEpermTriageResult: detects playbook P4 KNOWN output', () => {
  const result = [
    '既知（playbook P4）: Codex sandbox EPERM。',
    'connect EPERM 127.0.0.1:55432 and .tsbuildinfo write failed.',
    'VERDICT: KNOWN',
  ].join('\n');
  assert.equal(isCodexSandboxEpermTriageResult(result), true);
});

test('isCodexSandboxEpermTriageResult: does not classify ordinary known failures as P4', () => {
  const result = [
    '既知（playbook P1）: cold e2e flake。',
    'warm rerun passed.',
    'VERDICT: KNOWN',
  ].join('\n');
  assert.equal(isCodexSandboxEpermTriageResult(result), false);
});
