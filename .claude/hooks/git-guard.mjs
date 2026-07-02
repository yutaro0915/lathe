#!/usr/bin/env node
// PreToolUse(Bash) guard. Blocks git footguns and points to the correct command.
//  - broad `git add` (-A / --all / bare `.`): stages stray files (pnpm node_modules
//    symlinks, leftover AD entries). Caused two bad commits — stage explicit paths.
//  - force-push: FF-only discipline (AGENTS.md).
//  - main-branch code commits / cherry-pick / merge: must go through merge.mjs.
// Exit 2 = block; the message on stderr is fed back as the reason. Exit 0 = allow.
import process from 'node:process';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', () => resolve(''));
  });
}

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// --- Pure / testable exports ---

/**
 * Get the current git branch name.
 * Runs synchronously via child process; callers may mock for tests.
 * @returns {string}
 */
export function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Get the list of staged file paths from `git diff --cached --name-only`.
 * @returns {string[]}
 */
export function getStagedPaths() {
  try {
    const out = execSync('git diff --cached --name-only', { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function maskQuotedLiterals(cmd) {
  let masked = '';
  let quote = '';
  let escaped = false;

  for (const ch of cmd) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      masked += ch === '\n' ? '\n' : ' ';
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      masked += ' ';
      continue;
    }

    masked += ch;
  }

  return masked;
}

function hasGitSubcommandAtExecutionPosition(cmd, subcommandPattern) {
  const masked = maskQuotedLiterals(cmd);
  const re = new RegExp(String.raw`(?:^|[;|\n]|&&)\s*git\s+${subcommandPattern}`);
  return re.test(masked);
}

/**
 * Determine whether the given git command should be blocked on main.
 *
 * Rules (only when branch===main AND latheMerge!=='1'):
 *  - cherry-pick → block (must use merge.mjs)
 *  - merge <branch> → block (must use merge.mjs)
 *  - commit with code paths staged (apps/web/ or packages/) → block
 *    (docs/rubrics/.claude/memory only commits pass through)
 *
 * @param {string} cmd          the full bash command string
 * @param {string} branch       current branch name
 * @param {string} latheMerge  value of LATHE_MERGE env var (or '')
 * @param {string[]} stagedPaths  output of getStagedPaths()
 * @returns {{ block: boolean, message?: string }}
 */
export function shouldBlockOnMain(cmd, branch, latheMerge, stagedPaths) {
  // Not on main, or merge.mjs is driving → never block
  if (branch !== 'main' || latheMerge === '1') {
    return { block: false };
  }

  // cherry-pick
  if (hasGitSubcommandAtExecutionPosition(cmd, String.raw`cherry-pick\b`)) {
    return {
      block: true,
      message:
        'git-guard: main への直接 cherry-pick は禁止。\n' +
        '正しいやり方: node scripts/merge.mjs <branch>\n' +
        '  → review + verify receipt を強制して取り込みます。',
    };
  }

  // merge (branch merge — not `git merge-base` etc.)
  // match: `git merge <something>` but NOT `git merge-base`
  if (hasGitSubcommandAtExecutionPosition(cmd, String.raw`merge(?!-)\b`)) {
    return {
      block: true,
      message:
        'git-guard: main への直接 merge は禁止。\n' +
        '正しいやり方: node scripts/merge.mjs <branch>\n' +
        '  → review + verify receipt を強制して取り込みます。',
    };
  }

  // commit with code paths staged
  if (hasGitSubcommandAtExecutionPosition(cmd, String.raw`commit\b`)) {
    const CODE_PREFIXES = ['apps/web/', 'packages/'];
    const hasCode = stagedPaths.some((p) =>
      CODE_PREFIXES.some((prefix) => p.startsWith(prefix)),
    );
    if (hasCode) {
      return {
        block: true,
        message:
          'git-guard: main 上でのコードパス直接 commit は禁止。\n' +
          'コード変更は scripts/merge.mjs 経由でのみ main に入ります。\n' +
          'OPUS は main 上でコードを author しません。\n' +
          '（docs/rubrics/.claude/memory のみの commit は素通りします）',
      };
    }
  }

  return { block: false };
}

// --- CLI entrypoint (only runs when executed directly as a hook) ---

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const raw = await readStdin();
  let cmd = '';
  try {
    cmd = JSON.parse(raw || '{}')?.tool_input?.command ?? '';
  } catch {
    cmd = '';
  }

  // broad git add — `-A`, `--all`, or a bare `.` (but allow `./path`, `-u`, explicit paths)
  if (/\bgit\s+add\s+(-A\b|--all\b|\.(?:\s|;|&|\||$))/.test(cmd)) {
    block(
      'git-guard: broad `git add` (-A / --all / .) is blocked — it stages stray files ' +
        '(pnpm node_modules symlinks, leftover AD entries) and caused bad commits.\n' +
        '正しいやり方:\n' +
        '  1) `git reset`            # index をクリア\n' +
        '  2) `git add <path>...`    # 意図したファイルだけ明示的に\n' +
        '  3) `git diff --cached --stat`  # 入っているものを意図と照合\n' +
        '  削除は `git rm <path>`（または `git add -u <path>`）。',
    );
  }

  // force-push — FF only
  if (/\bgit\s+push\b[^\n;&|]*(--force\b|--force-with-lease\b|\s-f\b)/.test(cmd)) {
    block(
      'git-guard: force-push is blocked — Lathe は FF-only (force-push 禁止, AGENTS.md).\n' +
        '正しいやり方: `git push`（FF）。FF できない時は `git fetch` → `git rebase origin/<branch>` で整えてから push。',
    );
  }

  // main-branch code gate
  {
    const branch = getCurrentBranch();
    const latheMerge = process.env.LATHE_MERGE ?? '';
    const stagedPaths = getStagedPaths();
    const result = shouldBlockOnMain(cmd, branch, latheMerge, stagedPaths);
    if (result.block) {
      block(result.message);
    }
  }

  process.exit(0);
}
