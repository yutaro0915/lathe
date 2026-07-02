import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dumpRunState } from './watch-run.mjs';

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lathe-watch-run-'));
  mkdirSync(join(repoRoot, '.lathe', 'runs'), { recursive: true });
  writeFileSync(join(repoRoot, '.lathe', 'runs', 'issue-34.json'), JSON.stringify({
    issue: 34,
    stages: [
      { stage: 'PLAN', verdict: 'PLAN_READY', backend: 'claude', ts: '2026-07-02T00:00:00.000Z' },
    ],
  }), 'utf8');
  return repoRoot;
}

function gitRun(cmd, args) {
  if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: 'abc123 head\n' };
  if (cmd === 'git' && args[0] === 'worktree') return { status: 0, stdout: '/repo inner/issue-34\n' };
  if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '' };
  return { status: 0, stdout: '' };
}

test('dumpRunState: includes source-labeled cost report after manifest dump', () => {
  const repoRoot = makeRepo();
  try {
    const output = dumpRunState(34, {
      repoRoot,
      run: (cmd, args) => {
        if (cmd === 'node') {
          assert.deepEqual(args.slice(0, 3), ['--import', 'tsx', 'apps/web/scripts/run-manifest-cost-report.ts']);
          return {
            status: 0,
            stdout: [
              '# Run Manifest Cost Report',
              'status: ok',
              'stage_session_cost_source=db.sessions.cost_usd',
              'backend_cost_source=legacy_backend_cost_usd',
              '',
            ].join('\n'),
          };
        }
        return gitRun(cmd, args);
      },
    });

    assert.match(output, /## manifest \(issue\)/);
    assert.match(output, /PLAN: verdict=PLAN_READY backend=claude/);
    assert.match(output, /## cost report \(issue\)/);
    assert.match(output, /stage_session_cost_source=db\.sessions\.cost_usd/);
    assert.match(output, /backend_cost_source=legacy_backend_cost_usd/);
    assert.match(output, /## git state \(main\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dumpRunState: cost report failure is reported without suppressing the rest of the dump', () => {
  const repoRoot = makeRepo();
  try {
    const output = dumpRunState(34, {
      repoRoot,
      run: (cmd, args) => {
        if (cmd === 'node') return { status: 1, stdout: '', stderr: 'tsx failed' };
        return gitRun(cmd, args);
      },
    });

    assert.match(output, /## cost report \(issue\)/);
    assert.match(output, /cost report unavailable: tsx failed/);
    assert.match(output, /## git state \(main\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
