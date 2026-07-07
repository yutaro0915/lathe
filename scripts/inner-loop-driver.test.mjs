// Tests for the driver's side-effect helpers and the new single-issue CLI
// (#116): worktree setup, stage runner env, landBranch (PR body carries
// Closes #N, auto-merge armed at PR creation, no review-body posting), and
// dry-run behaviour for both run types via a fake gh on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  setupWorktreeDeps,
  prepareWorktree,
  rebaseWorktree,
  runStage,
  landBranch,
  WORKTREE_DEPS_INSTALL_ARGS,
} from './inner-loop.mjs';

// --- setupWorktreeDeps ---

test('setupWorktreeDeps: runs pnpm install frozen prefer-offline in the worktree cwd', () => {
  const calls = [];
  const result = setupWorktreeDeps('/tmp/wt', {
    spawnSync: (cmd, args, options) => { calls.push({ cmd, args, options }); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'pnpm');
  assert.deepEqual(calls[0].args, WORKTREE_DEPS_INSTALL_ARGS);
  assert.equal(calls[0].options.cwd, '/tmp/wt');
});

test('setupWorktreeDeps: warns and returns ok=false when pnpm install fails (P3 fallback)', () => {
  const logs = [];
  const result = setupWorktreeDeps('/tmp/wt', {
    spawnSync: () => ({ status: 1 }),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.includes('continuing with P3 fallback')));
});

// --- prepareWorktree ---

test('prepareWorktree: creates the git worktree then prepares deps before returning', () => {
  const order = [];
  const result = prepareWorktree(42, {
    existsSync: () => false,
    spawnSync: (cmd, args) => { order.push(`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()); return { status: 0 }; },
    setupWorktreeDeps: (path) => { order.push(`deps ${path}`); return { ok: true }; },
  });
  assert.equal(result.branch, 'inner/issue-42');
  assert.ok(result.path.endsWith('.claude/worktrees/inner-issue-42'));
  assert.equal(order.length, 2);
  assert.match(order[0], /^git worktree/);
  assert.match(order[1], /^deps /);
});

// --- rebaseWorktree ---

test('rebaseWorktree: successful rebase runs rebase main and returns true', () => {
  const calls = [];
  const ok = rebaseWorktree('/tmp/wt', {
    spawnSync: (cmd, args) => { calls.push(args.join(' ')); return { status: 0 }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['-C /tmp/wt rebase main']);
});

test('rebaseWorktree: failed rebase aborts before returning false', () => {
  const calls = [];
  const ok = rebaseWorktree('/tmp/wt', {
    spawnSync: (cmd, args) => { calls.push(args.join(' ')); return { status: calls.length === 1 ? 1 : 0 }; },
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, ['-C /tmp/wt rebase main', '-C /tmp/wt rebase --abort']);
});

// --- runStage backend env ---

test('runStage: claude backend passes LATHE_STAGE env for the stage', () => {
  let seenEnv = null;
  const envelope = runStage('IMPLEMENT', 'prompt', '/tmp/wt', null, 'claude', {
    spawnSync: (cmd, args, options) => {
      seenEnv = options.env;
      return { status: 0, stdout: JSON.stringify({ session_id: 's', result: 'VERDICT: IMPL_DONE', total_cost_usd: 0.1 }) };
    },
  });
  assert.equal(seenEnv.LATHE_STAGE, 'IMPLEMENT');
  assert.equal(envelope.backend, 'claude');
  assert.equal(envelope.result, 'VERDICT: IMPL_DONE');
});

// --- landBranch ---

function fakeLandRun({ failAt = null } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const key = `${cmd} ${args.slice(0, 2).join(' ')}`.trim();
    calls.push({ cmd, args, key });
    if (cmd === 'git' && args[0] === 'log') {
      return { status: 0, stdout: 'feat: subject line\n\ncommit body text\0fix: follow-up\0', stderr: '' };
    }
    if (failAt && key.startsWith(failAt)) return { status: 1, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('landBranch: happy path — push → pr create (Closes #N in body) → auto-merge arm at PR creation', () => {
  const { run, calls } = fakeLandRun();
  const result = landBranch('inner/issue-42', 42, { spawnSync: run });
  assert.equal(result.ok, true);
  const keys = calls.map((c) => c.key);
  assert.deepEqual(keys, ['git log --reverse', 'git push -u', 'gh pr create', 'gh pr merge']);

  const prCreate = calls.find((c) => c.key === 'gh pr create');
  const bodyIndex = prCreate.args.indexOf('--body') + 1;
  assert.equal(prCreate.args[bodyIndex], 'commit body text\n\nCloses #42');
  const titleIndex = prCreate.args.indexOf('--title') + 1;
  assert.equal(prCreate.args[titleIndex], 'feat: subject line');
});

test('landBranch: no gh pr review step remains (LATHE_REVIEW_BODY_FILE 過渡形の撤去)', () => {
  const { run, calls } = fakeLandRun();
  landBranch('inner/issue-42', 42, { spawnSync: run });
  assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[1] === 'review'));
});

test('landBranch: no commits between main and branch → fails before push', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args[0]}`);
    if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: '\0', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = landBranch('inner/issue-42', 42, { spawnSync: run });
  assert.equal(result.ok, false);
  assert.match(result.output, /no commits found/);
  assert.ok(!calls.includes('git push'));
});

test('landBranch: git push failure → fails without any gh call', () => {
  const { run, calls } = fakeLandRun({ failAt: 'git push' });
  const result = landBranch('inner/issue-42', 42, { spawnSync: run });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((c) => c.cmd === 'gh'));
});

test('landBranch: gh pr create failure → fails without arming auto-merge', () => {
  const { run, calls } = fakeLandRun({ failAt: 'gh pr create' });
  const result = landBranch('inner/issue-42', 42, { spawnSync: run });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((c) => c.key === 'gh pr merge'));
});

// --- CLI dry-run with a fake gh on PATH ---

function setupFakeGh(testId, { labels, body }) {
  const fakeBin = join(tmpdir(), `lathe-inner-cli-${testId}-${process.pid}-${Date.now()}`);
  mkdirSync(fakeBin, { recursive: true });
  const issueJson = JSON.stringify({
    number: 4242,
    title: 'Fake issue title',
    body,
    labels: labels.map((name) => ({ name })),
    state: 'OPEN',
    comments: [{ author: { login: 'yutaro0915' }, createdAt: '2026-07-07T00:00:00Z', body: '裁定 comment' }],
  });
  writeFileSync(join(fakeBin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(${JSON.stringify(issueJson)} + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`, 'utf8');
  chmodSync(join(fakeBin, 'gh'), 0o755);
  return { fakeBin, cleanup: () => rmSync(fakeBin, { recursive: true, force: true }) };
}

function runDriverCli(args, fakeBin) {
  return spawnSync(process.execPath, ['scripts/inner-loop.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
}

test('CLI dry-run (task loop): prints the shrunk stage plan and LAND with Closes #N', () => {
  const fake = setupFakeGh('task', { labels: ['task-request'], body: 'plan body\nblocked-by #7' });
  try {
    const r = runDriverCli(['4242', '--dry-run'], fake.fakeBin);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('dry-run: task loop issue #4242'));
    assert.ok(r.stdout.includes('stage plan — IMPLEMENT -> LAND'));
    assert.ok(r.stdout.includes('blocked-by — would check #7'));
    assert.ok(r.stdout.includes('Closes #4242'));
    assert.ok(r.stdout.includes('IMPL_DONE->LAND'));
    assert.ok(r.stdout.includes('裁定 comment'));
    // removed stages must not appear in the transition plan
    assert.ok(!r.stdout.includes('REVIEW PASS'));
    assert.ok(!r.stdout.includes('TRIAGE'));
  } finally {
    fake.cleanup();
  }
});

test('CLI dry-run (plan-task): needs-plan label routes to the plan-task run type with plan-format injection', () => {
  const fake = setupFakeGh('plan', { labels: ['task-request', 'needs-plan'], body: 'please split this' });
  try {
    const r = runDriverCli(['4242', '--dry-run'], fake.fakeBin);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('dry-run: plan-task issue #4242'));
    assert.ok(r.stdout.includes('stage plan — PLAN -> FILE_CHILDREN'));
    assert.ok(r.stdout.includes('plan-format injection — design/plan-format.md read fail-closed'));
    assert.ok(r.stdout.includes('完全形の5セクション'));
    assert.ok(r.stdout.includes('gh issue create --label task-request'));
    assert.ok(r.stdout.includes('ASK_PDM'));
  } finally {
    fake.cleanup();
  }
});

test('CLI: legacy flags are rejected with the new usage line', () => {
  const r = spawnSync(process.execPath, ['scripts/inner-loop.mjs', '--plan', '9'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument: --plan/);
  assert.match(r.stderr, /usage: node scripts\/inner-loop\.mjs <issue#>/);
});
