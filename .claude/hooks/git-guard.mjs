#!/usr/bin/env node
// PreToolUse(Bash) guard. Blocks git footguns and points to the correct command.
//  - broad `git add` (-A / --all / bare `.`): stages stray files (pnpm node_modules
//    symlinks, leftover AD entries). Caused two bad commits — stage explicit paths.
//  - force-push: FF-only discipline (AGENTS.md).
//
// The main-branch rules (cherry-pick / merge / code-path commit) were REMOVED
// (ADR 0026 §1, TASK-22): branch protection now physically enforces "main の唯一の
// 入口 = PR + CI GREEN". Enumerating local bypass patterns was a losing arms race
// (cherry-pick → checkout → apply …); the trust boundary lives on the remote instead.
// git-guard keeps only these two advisory blocks.
//
// Exit 2 = block; the message on stderr is fed back as the reason. Exit 0 = allow.
import process from 'node:process';
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

  process.exit(0);
}
