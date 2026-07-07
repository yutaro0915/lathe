// harness-separation.test.mjs
// 物理分離の機械検証（issue #225）。
// (a) git 管理境界: settings.json = tracked, settings.local.json = untracked
// (b) driver worktree 非同梱: inner/issue-* worktree に settings.local.json が現れない
// (c) issue-create-guard 判定: decideIssueCreate 純関数の入力駆動
// (d) spawn --settings pin: claude 向けビルダが INNER_SETTINGS_PATH を argv に含む

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { INNER_SETTINGS_PATH, REPO_ROOT } from './inner-loop-core.mjs';
import { buildClaudeArgs, buildCodexArgs } from './inner-loop-backends.mjs';
import { runStage } from './inner-loop-stage-runner.mjs';
import { buildDispatchSpec } from './orchestrator.mjs';
import { CLASS_EXPLAIN } from './orchestrator-classify.mjs';
import { decideIssueCreate } from '../ops/outer-harness/hooks/issue-create-guard.mjs';

// ---------------------------------------------------------------------------
// (a) git 管理境界
// ---------------------------------------------------------------------------

test('(a) .claude/settings.json は git 管理下にある（tracked）', () => {
  const out = execFileSync('git', ['ls-files', '.claude/settings.json'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  }).trim();
  assert.ok(out.length > 0, '.claude/settings.json が git ls-files に現れない — tracked でなければ --settings pin が機能しない');
});

test('(a) .claude/settings.local.json は git 管理外（untracked）', () => {
  const out = execFileSync('git', ['ls-files', '.claude/settings.local.json'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  }).trim();
  assert.equal(out, '', '.claude/settings.local.json が tracked になっている — local 層は追跡禁止');
});

// ---------------------------------------------------------------------------
// (b) driver worktree 非同梱
// ---------------------------------------------------------------------------

test('(b) inner/issue-* worktree に .claude/settings.local.json が存在しない', () => {
  const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });

  // パースして inner/issue-* ブランチの worktree を抽出
  const innerWorktrees = raw
    .trim()
    .split(/\n\n+/)
    .map(block => {
      const lines = block.split('\n');
      const pathLine = lines.find(l => l.startsWith('worktree '));
      const branchLine = lines.find(l => l.startsWith('branch '));
      return {
        path: pathLine?.slice('worktree '.length).trim() ?? '',
        branch: branchLine?.slice('branch '.length).trim() ?? '',
      };
    })
    .filter(wt => /^refs\/heads\/inner\/issue-\d+$/.test(wt.branch));

  // settings.local.json が存在する worktree を検出
  const stray = innerWorktrees.filter(
    wt => wt.path && existsSync(join(wt.path, '.claude', 'settings.local.json')),
  );

  if (stray.length > 0) {
    const detail = stray
      .map(wt => `  ${wt.path}/.claude/settings.local.json  (branch: ${wt.branch})`)
      .join('\n');
    assert.fail(
      `settings.local.json が driver worktree に同梱されています — 生成元を特定して別 issue で修正:\n${detail}`,
    );
  }
  // inner-issue worktree が 0 件の場合は vacuously pass
});

// ---------------------------------------------------------------------------
// (c) issue-create-guard 判定（純関数・副作用なし）
// ---------------------------------------------------------------------------

test('(c) decideIssueCreate: gh issue create コマンドは ask を返す', () => {
  const result = decideIssueCreate({ tool_input: { command: 'gh issue create --title "foo" --body "bar"' } });
  assert.ok(result !== null, 'null が返った — ask を期待');
  assert.equal(result.decision, 'ask');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'reason が空');
});

test('(c) decideIssueCreate: 無害コマンドは null を返す（素通し）', () => {
  const result = decideIssueCreate({ tool_input: { command: 'gh issue list' } });
  assert.equal(result, null, 'gh issue list に ask が返った — forbidden path のみに限定すること');
});

test('(c) decideIssueCreate: gh api POST /issues は ask を返す', () => {
  const result = decideIssueCreate({
    tool_input: { command: 'gh api -X POST repos/org/repo/issues --field title=foo' },
  });
  assert.ok(result !== null, 'null が返った — REST 起票も検出対象');
  assert.equal(result.decision, 'ask');
});

test('(c) decideIssueCreate: gh api POST /issues/<n>/comments は素通し', () => {
  // issue comment は起票でない — 対象外
  const result = decideIssueCreate({
    tool_input: { command: 'gh api -X POST repos/org/repo/issues/42/comments --field body=hi' },
  });
  assert.equal(result, null, '/issues/<n>/comments が誤って検出された');
});

test('(c) decideIssueCreate: GraphQL createIssue mutation は ask を返す', () => {
  const result = decideIssueCreate({
    tool_input: { command: 'gh api graphql -f query="mutation { createIssue( input: {} ) { issue { id } } }"' },
  });
  assert.ok(result !== null, 'GraphQL createIssue が検出されなかった');
  assert.equal(result.decision, 'ask');
});

// ---------------------------------------------------------------------------
// (d) spawn --settings pin（claude 向けビルダ）
// ---------------------------------------------------------------------------

test('(d) buildClaudeArgs: --settings INNER_SETTINGS_PATH を argv に含む', () => {
  const argv = buildClaudeArgs('IMPLEMENT', 'dummy prompt', null);
  const settingsIdx = argv.indexOf('--settings');
  assert.ok(settingsIdx !== -1, 'buildClaudeArgs の argv に --settings フラグがない');
  assert.equal(
    argv[settingsIdx + 1],
    INNER_SETTINGS_PATH,
    `--settings の値が INNER_SETTINGS_PATH と一致しない: got ${argv[settingsIdx + 1]}`,
  );
});

test('(d) buildDispatchSpec CLASS_EXPLAIN: --settings INNER_SETTINGS_PATH を argv に含む', () => {
  const spec = buildDispatchSpec({ class: CLASS_EXPLAIN, number: 1 });
  assert.equal(spec.command, 'claude', 'EXPLAIN dispatch は claude コマンドであるべき');
  const settingsIdx = spec.args.indexOf('--settings');
  assert.ok(settingsIdx !== -1, 'buildDispatchSpec(EXPLAIN) の argv に --settings フラグがない');
  assert.equal(
    spec.args[settingsIdx + 1],
    INNER_SETTINGS_PATH,
    `--settings の値が INNER_SETTINGS_PATH と一致しない: got ${spec.args[settingsIdx + 1]}`,
  );
});

test('(d) runStage(claude) deps.spawnSync fake 注入: spawnSync に渡す argv が --settings INNER_SETTINGS_PATH を含む', () => {
  let capturedCmd = null;
  let capturedArgs = null;
  const fakeSpawnSync = (cmd, args, _opts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    // runStageClaude は stdout を JSON.parse するため有効な envelope を返す
    return {
      status: 0,
      stdout: JSON.stringify({ session_id: 'fake', result: '', total_cost_usd: 0 }),
      stderr: '',
    };
  };

  runStage('IMPLEMENT', 'test prompt', REPO_ROOT, null, 'claude', { spawnSync: fakeSpawnSync });

  assert.equal(capturedCmd, 'claude', 'fake spawnSync の第 1 引数 (command) が "claude" でない');
  assert.ok(capturedArgs !== null, 'fake spawnSync が呼ばれなかった');
  const settingsIdx = capturedArgs.indexOf('--settings');
  assert.ok(settingsIdx !== -1, 'runStage(claude) が spawnSync に渡す argv に --settings フラグがない — 統合照合の穴');
  assert.equal(
    capturedArgs[settingsIdx + 1],
    INNER_SETTINGS_PATH,
    `--settings の値が INNER_SETTINGS_PATH と一致しない: got ${capturedArgs[settingsIdx + 1]}`,
  );
});

test('(d) buildCodexArgs: --settings を argv に含まない（codex には settings pin 不要）', () => {
  // codex に誤って INNER_SETTINGS_PATH が混入しないことを収束 assert する
  const argv = buildCodexArgs('IMPLEMENT', 'dummy prompt', REPO_ROOT, '/tmp/lathe-lastmsg.txt', REPO_ROOT);
  assert.ok(
    !argv.includes('--settings'),
    `buildCodexArgs の argv に --settings が混入している — codex は settings pin 対象外: ${argv.join(' ')}`,
  );
});
