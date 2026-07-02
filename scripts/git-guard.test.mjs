import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockOnMain } from '../.claude/hooks/git-guard.mjs';

// cherry-pick on main → block
test('shouldBlockOnMain: cherry-pick on main → block', () => {
  const r = shouldBlockOnMain('git cherry-pick abc', 'main', '0', []);
  assert.equal(r.block, true);
  assert.ok(r.message);
});

// merge on main → block
test('shouldBlockOnMain: merge on main → block', () => {
  const r = shouldBlockOnMain('git merge feature-x', 'main', '0', []);
  assert.equal(r.block, true);
  assert.ok(r.message);
});

// commit with apps/web staged on main → block
test('shouldBlockOnMain: commit with apps/web path staged on main → block', () => {
  const r = shouldBlockOnMain('git commit -m "fix"', 'main', '0', ['apps/web/foo.ts']);
  assert.equal(r.block, true);
  assert.ok(r.message);
});

// quoted issue body mentions guarded git subcommands → pass
test('shouldBlockOnMain: gh body mentioning guarded git subcommands on main → pass', () => {
  const r = shouldBlockOnMain(
    'gh issue create --body "please do not run git merge / git cherry-pick / git commit directly"',
    'main',
    '0',
    ['apps/web/foo.ts'],
  );
  assert.equal(r.block, false);
});

// quoted echo text mentions guarded git subcommands → pass
test('shouldBlockOnMain: echo mentioning guarded git subcommands on main → pass', () => {
  const r = shouldBlockOnMain(
    'echo "git merge feature && git cherry-pick abc && git commit"',
    'main',
    '0',
    ['apps/web/foo.ts'],
  );
  assert.equal(r.block, false);
});

// commit with docs only staged on main → pass
test('shouldBlockOnMain: commit with docs only staged on main → pass', () => {
  const r = shouldBlockOnMain('git commit -m "docs"', 'main', '0', ['docs/README.md']);
  assert.equal(r.block, false);
});

// commit with rubrics only staged on main → pass
test('shouldBlockOnMain: commit with rubrics path on main → pass', () => {
  const r = shouldBlockOnMain('git commit -m "rubric"', 'main', '0', ['rubrics/foo.mjs']);
  assert.equal(r.block, false);
});

// cherry-pick on feature branch → pass
test('shouldBlockOnMain: cherry-pick on feature branch → pass (worktree)', () => {
  const r = shouldBlockOnMain('git cherry-pick abc', 'feature-foo', '0', []);
  assert.equal(r.block, false);
});

// cherry-pick on main with LATHE_MERGE=1 → pass (merge.mjs internal)
test('shouldBlockOnMain: cherry-pick on main with LATHE_MERGE=1 → pass', () => {
  const r = shouldBlockOnMain('git cherry-pick abc', 'main', '1', []);
  assert.equal(r.block, false);
});

// merge-base is not blocked (git merge-base ≠ git merge)
test('shouldBlockOnMain: merge-base command on main → pass', () => {
  const r = shouldBlockOnMain('git merge-base main feature', 'main', '0', []);
  assert.equal(r.block, false);
});

// guarded subcommands after a shell list operator still block
test('shouldBlockOnMain: merge after && on main → block', () => {
  const r = shouldBlockOnMain('echo ok && git merge feature-x', 'main', '0', []);
  assert.equal(r.block, true);
  assert.ok(r.message);
});

// packages/ path staged on main → block
test('shouldBlockOnMain: commit with packages/ path staged on main → block', () => {
  const r = shouldBlockOnMain('git commit -m "feat"', 'main', '0', ['packages/core/index.ts']);
  assert.equal(r.block, true);
});

// commit with .claude/ path only staged on main → pass
test('shouldBlockOnMain: commit with .claude/ only staged on main → pass', () => {
  const r = shouldBlockOnMain('git commit -m "hook update"', 'main', '0', ['.claude/hooks/git-guard.mjs']);
  assert.equal(r.block, false);
});
