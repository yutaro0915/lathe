#!/usr/bin/env node
// PreToolUse(Bash) guard. Blocks git footguns and points to the correct command.
//  - broad `git add` (-A / --all / bare `.`): stages stray files (pnpm node_modules
//    symlinks, leftover AD entries). Caused two bad commits — stage explicit paths.
//  - force-push: FF-only discipline (AGENTS.md).
// Exit 2 = block; the message on stderr is fed back as the reason. Exit 0 = allow.
import process from 'node:process';

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', () => resolve(''));
  });
}

const raw = await readStdin();
let cmd = '';
try {
  cmd = JSON.parse(raw || '{}')?.tool_input?.command ?? '';
} catch {
  cmd = '';
}

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
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
    'git-guard: force-push is blocked — Lathe is FF-only (force-push 禁止, AGENTS.md).\n' +
      '正しいやり方: `git push`（FF）。FF できない時は `git fetch` → `git rebase origin/<branch>` で整えてから push。',
  );
}

process.exit(0);
