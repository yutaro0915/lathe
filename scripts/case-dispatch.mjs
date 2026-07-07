#!/usr/bin/env node
/**
 * case-dispatch.mjs — SSH 越し case task 受け渡し機構 (issue #231)
 *
 * 役割: Mac から case 上の Claude Code に task を渡し、case 側で完結させる 1 入口 CLI。
 * allowedTools は必須・既定値なし — 呼び出し側が常に明示する設計（最小権限の散逸防止）。
 *
 * CLI:
 *   node scripts/case-dispatch.mjs --issue <n> --task-file <path> [--repo-dir <dir>]
 *
 * Bootstrap 前提 (2026-07-08 実測確認済み):
 *   - SSH alias: Host case → 192.168.11.14 (User cherie, 鍵認証 BatchMode=yes)
 *   - case 上: ~/lathe clone, gh auth 済み, oauth-token: ~/.config/claude-code/oauth-token
 *   - 疎通確認済み: ssh case 'cd ~/lathe && CLAUDE_CODE_OAUTH_TOKEN=$(tr -d "\n" < ~/.config/claude-code/oauth-token) claude -p "reply with exactly: OK"'
 *
 * フロー:
 *   Mac: case-dispatch.mjs --issue <n> --task-file <path>
 *        └─ ssh case 'cd <repoDir> && CLAUDE_CODE_OAUTH_TOKEN=... claude -p "<task>" --allowedTools ...'
 *                                └─ case 上 claude が gh issue view #n を読み実装
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// case 側 inner-loop 実装ランの最小権限セット（CLI デフォルト）。
// 呼び出し側は必要に応じて allowedTools を上書きすること。
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Write', 'Edit',
  'Bash(git:*)', 'Bash(gh:*)', 'Bash(node:*)', 'Bash(pnpm:*)',
];

// case 上のデフォルト repo パス（bootstrap 実測で確認済み）
const DEFAULT_REPO_DIR = '~/lathe';

// ssh ホスト alias（~/.ssh/config に登録済み）
const SSH_HOST = 'case';

/**
 * シェル単引用符内で安全に埋め込める形にエスケープする。
 *   ' → '\''
 */
function shellSingleQuoteEscape(s) {
  return s.replace(/'/g, "'\\''");
}

/**
 * buildRemoteCmd — case 上で実行するシェルコマンド文字列を構築する（純関数・テスト可能）。
 *
 * @param {object} opts
 * @param {number}   opts.issue        - 対象 issue 番号（case 側 claude が gh view する）
 * @param {string}   opts.taskPrompt   - claude -p に渡す本文
 * @param {string[]} opts.allowedTools - 必須・空不可。最小権限集合を呼び出し側が明示。
 * @param {string}   opts.repoDir      - case 上の repo 絶対パス（例: /home/cherie/lathe）
 * @returns {string} SSH で case に渡すシェルコマンド文字列
 */
export function buildRemoteCmd(opts) {
  const { issue, taskPrompt, allowedTools, repoDir } = opts;

  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    throw new Error(
      'allowedTools is required and must be non-empty. ' +
      'Provide the minimum tool set explicitly to prevent permission sprawl.'
    );
  }

  // repoDir: 先頭の ~/ を $HOME/ に正規化し、ダブルクォートで囲む。
  // （単引用符内では ~ が展開されないため; $HOME はリモートシェルが展開する）
  const normalizedRepo = repoDir.startsWith('~/') ? `$HOME/${repoDir.slice(2)}` : repoDir;
  const safeRepo = `"${normalizedRepo.replace(/"/g, '\\"')}"`;


  // taskPrompt を単引用符でエスケープ
  const safeTask = `'${shellSingleQuoteEscape(taskPrompt)}'`;

  // --allowedTools "Tool1" "Tool2" ... （リモートシェルが各引数として展開）
  const toolsArgs = allowedTools.map(t => `"${t.replace(/"/g, '\\"')}"`).join(' ');

  // CLAUDE_CODE_OAUTH_TOKEN を oauth-token ファイルから読み込み（case 側）
  const tokenExpr = 'CLAUDE_CODE_OAUTH_TOKEN=$(tr -d "\\n" < ~/.config/claude-code/oauth-token)';

  const remoteCmd = [
    `cd ${safeRepo}`,
    `${tokenExpr} claude -p ${safeTask} --allowedTools ${toolsArgs}`,
  ].join(' && ');

  return remoteCmd;
}

/**
 * dispatchToCase — SSH 経由で case 上の claude を起動し結果を返す。
 *
 * @param {object} opts
 * @param {number}   opts.issue        - 対象 issue 番号
 * @param {string}   opts.taskPrompt   - claude -p に渡す本文
 * @param {string[]} opts.allowedTools - 必須・空不可。SETUP.md §6 と同型の最小集合。
 * @param {string}   opts.repoDir      - case 上 repo 絶対パス
 * @returns {Promise<{ exitCode: number; log: string }>}
 */
export async function dispatchToCase(opts) {
  const remoteCmd = buildRemoteCmd(opts); // validation はここで throw

  const result = spawnSync('ssh', [SSH_HOST, remoteCmd], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [result.stdout ?? '', result.stderr ?? '']
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n');

  return {
    exitCode: result.status ?? 1,
    log,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);

  function parseFlag(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const issueStr  = parseFlag('--issue');
  const taskFile  = parseFlag('--task-file');
  const repoDir   = parseFlag('--repo-dir') ?? DEFAULT_REPO_DIR;

  if (!issueStr || !taskFile) {
    process.stderr.write(
      'Usage: node scripts/case-dispatch.mjs --issue <n> --task-file <path> [--repo-dir <dir>]\n' +
      `  --repo-dir defaults to "${DEFAULT_REPO_DIR}"\n` +
      `  allowedTools: DEFAULT_ALLOWED_TOOLS (${DEFAULT_ALLOWED_TOOLS.join(', ')})\n`
    );
    process.exit(1);
  }

  const issue = parseInt(issueStr, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    process.stderr.write(`[case-dispatch] --issue must be a positive integer, got: ${issueStr}\n`);
    process.exit(1);
  }

  let taskPrompt;
  try {
    taskPrompt = readFileSync(taskFile, 'utf8').trim();
  } catch (e) {
    process.stderr.write(`[case-dispatch] cannot read task file "${taskFile}": ${e.message}\n`);
    process.exit(1);
  }

  if (!taskPrompt) {
    process.stderr.write(`[case-dispatch] task file "${taskFile}" is empty\n`);
    process.exit(1);
  }

  process.stderr.write(`[case-dispatch] dispatching issue #${issue} to ${SSH_HOST}:${repoDir}\n`);
  process.stderr.write(`[case-dispatch] allowedTools: ${DEFAULT_ALLOWED_TOOLS.join(', ')}\n`);

  dispatchToCase({ issue, taskPrompt, allowedTools: DEFAULT_ALLOWED_TOOLS, repoDir })
    .then(({ exitCode, log }) => {
      if (log) process.stdout.write(log + '\n');
      process.exit(exitCode);
    })
    .catch(e => {
      process.stderr.write(`[case-dispatch] fatal: ${e.message}\n`);
      process.exit(1);
    });
}
