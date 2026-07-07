// Unit tests for case-dispatch.mjs (issue #231)
// 検証要件:
//   - allowedTools が欠落・空のとき throw する
//   - 構築する remoteCmd に --allowedTools が必ず含まれる
//   - 実 SSH は呼び出さない（純関数 buildRemoteCmd のみテスト）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteCmd, DEFAULT_ALLOWED_TOOLS } from './case-dispatch.mjs';

const BASE_OPTS = {
  issue: 231,
  taskPrompt: 'reply with exactly: OK',
  allowedTools: ['Read', 'Grep'],
  repoDir: '/home/cherie/lathe',
};

// ── allowedTools バリデーション ───────────────────────────────────────────

test('buildRemoteCmd: allowedTools が空配列 → throw', () => {
  assert.throws(
    () => buildRemoteCmd({ ...BASE_OPTS, allowedTools: [] }),
    /allowedTools is required and must be non-empty/,
  );
});

test('buildRemoteCmd: allowedTools が undefined → throw', () => {
  const opts = { ...BASE_OPTS };
  delete opts.allowedTools;
  assert.throws(
    () => buildRemoteCmd(opts),
    /allowedTools is required and must be non-empty/,
  );
});

test('buildRemoteCmd: allowedTools が null → throw', () => {
  assert.throws(
    () => buildRemoteCmd({ ...BASE_OPTS, allowedTools: null }),
    /allowedTools is required and must be non-empty/,
  );
});

// ── 構築結果の構造検証 ────────────────────────────────────────────────────

test('buildRemoteCmd: --allowedTools が必ず argv に含まれる', () => {
  const cmd = buildRemoteCmd(BASE_OPTS);
  assert.ok(
    cmd.includes('--allowedTools'),
    `--allowedTools が remoteCmd に無い: ${cmd}`,
  );
});

test('buildRemoteCmd: 指定した各 tool が remoteCmd に含まれる', () => {
  const tools = ['Read', 'Grep', 'Glob'];
  const cmd = buildRemoteCmd({ ...BASE_OPTS, allowedTools: tools });
  for (const t of tools) {
    assert.ok(cmd.includes(t), `tool "${t}" が remoteCmd に無い: ${cmd}`);
  }
});

test('buildRemoteCmd: repoDir が remoteCmd に含まれる', () => {
  const cmd = buildRemoteCmd(BASE_OPTS);
  assert.ok(
    cmd.includes('/home/cherie/lathe'),
    `repoDir が remoteCmd に無い: ${cmd}`,
  );
});

test('buildRemoteCmd: ~/repoDir は $HOME/ に正規化される（単引用符内でチルダが展開されない問題の回避）', () => {
  const cmd = buildRemoteCmd({ ...BASE_OPTS, repoDir: '~/lathe' });
  // ~ がそのまま単引用符で囲まれていないこと
  assert.ok(!cmd.includes("'~/lathe'"), `チルダが単引用符内に残っている: ${cmd}`);
  // $HOME に変換されていること
  assert.ok(cmd.includes('$HOME/lathe'), `$HOME/lathe が remoteCmd に無い: ${cmd}`);
});

test('buildRemoteCmd: taskPrompt が remoteCmd に含まれる', () => {
  const cmd = buildRemoteCmd(BASE_OPTS);
  assert.ok(
    cmd.includes('reply with exactly: OK'),
    `taskPrompt が remoteCmd に無い: ${cmd}`,
  );
});

test('buildRemoteCmd: claude -p が remoteCmd に含まれる', () => {
  const cmd = buildRemoteCmd(BASE_OPTS);
  assert.ok(cmd.includes('claude -p'), `claude -p が remoteCmd に無い: ${cmd}`);
});

test("buildRemoteCmd: taskPrompt 内の単引用符がエスケープされる（' → '\\'\\''）", () => {
  const cmd = buildRemoteCmd({ ...BASE_OPTS, taskPrompt: "it's a test" });
  // 単引用符がそのまま埋め込まれていないこと（シェル構文を壊さない）
  // エスケープ済み = "it'\''s a test" が含まれる
  assert.ok(
    cmd.includes("it'\\''s a test"),
    `単引用符のエスケープが不正: ${cmd}`,
  );
});

test('buildRemoteCmd: CLAUDE_CODE_OAUTH_TOKEN が remoteCmd に含まれる', () => {
  const cmd = buildRemoteCmd(BASE_OPTS);
  assert.ok(
    cmd.includes('CLAUDE_CODE_OAUTH_TOKEN'),
    `CLAUDE_CODE_OAUTH_TOKEN が remoteCmd に無い: ${cmd}`,
  );
});

// ── DEFAULT_ALLOWED_TOOLS 構造チェック ────────────────────────────────────

test('DEFAULT_ALLOWED_TOOLS: 非空配列である', () => {
  assert.ok(Array.isArray(DEFAULT_ALLOWED_TOOLS));
  assert.ok(DEFAULT_ALLOWED_TOOLS.length > 0);
});
