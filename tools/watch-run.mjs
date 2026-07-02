#!/usr/bin/env node
// tools/watch-run.mjs — run watcher の定型化（ADR 0017 tool-loop 初弾 2/2）
//
// scripts/inner-loop.mjs <issue#> [--plan] のプロセスを pgrep で見つけ、終了までポーリングする。
// 見つからなければ「見つからない」表示で manifest の現状だけ出して exit 0（driver 未起動でも使える）。
// 終了検知後（または --once 指定時）に dump する: manifest の段/verdict/backend 一覧・
// escalation ファイルの有無と先頭 20 行・git log --oneline -2（main）・
// git worktree list | grep inner・git status --porcelain（tracked のみ、main dirty 検知）。
// read-only（repo 状態・DB・git を変更しない）。
//
// Usage:
//   node tools/watch-run.mjs <issue#>          見つかれば終了までポーリング、その後 dump
//   node tools/watch-run.mjs <issue#> --once    監視せず現状 dump のみ

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const POLL_INTERVAL_MS = 18000; // 15-20s のレンジ内
const ESCALATION_HEAD_LINES = 20;

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- process discovery -------------------------------------------------

// Find the PID of a running `node scripts/inner-loop.mjs <issueNumber> [...]`
// (or `--plan <issueNumber>`) process via pgrep -f. Returns null if none found.
export function findRunPid(issueNumber, pgrepOutput) {
  const pattern = new RegExp(`inner-loop\\.mjs\\b.*(?:^|\\s)(?:--plan\\s+)?${issueNumber}(?:\\s|$)`);
  for (const line of String(pgrepOutput ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, cmd] = match;
    if (pattern.test(cmd)) return Number(pid);
  }
  return null;
}

function pgrepInnerLoop() {
  const r = run('pgrep', ['-fl', 'inner-loop.mjs']);
  // pgrep exits 1 when there are no matches — that's a normal "not found", not an error.
  if (r.status !== 0 && r.status !== 1) {
    process.stderr.write(`watch-run: warning: pgrep failed (${r.stderr || r.status})\n`);
    return '';
  }
  return r.stdout ?? '';
}

function pidAlive(pid) {
  const r = run('kill', ['-0', String(pid)]);
  return r.status === 0;
}

// --- manifest / escalation dump -----------------------------------------

function manifestPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.json`);
}

function planManifestPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `plan-${issueNumber}.json`);
}

function escalationPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `issue-${issueNumber}.escalation.md`);
}

function planEscalationPathFor(issueNumber) {
  return join(REPO_ROOT, '.lathe', 'runs', `plan-${issueNumber}.escalation.md`);
}

export function readManifestStages(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(data.stages) ? data.stages : [];
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function formatStageLine(entry) {
  const stage = entry?.stage ?? '(unknown)';
  const verdict = entry?.verdict ?? '(none)';
  const backend = entry?.backend ?? '(n/a)';
  const ts = entry?.ts ?? '(no ts)';
  return `  ${stage}: verdict=${verdict} backend=${backend} ts=${ts}`;
}

function dumpManifest(label, manifestPath) {
  const lines = [`## manifest (${label}): ${manifestPath}`];
  if (!existsSync(manifestPath)) {
    lines.push('  (not found)');
    return lines.join('\n');
  }
  const stages = readManifestStages(manifestPath);
  if (stages == null) {
    lines.push('  (not found)');
  } else if (!Array.isArray(stages)) {
    lines.push(`  (could not parse: ${stages.error})`);
  } else if (stages.length === 0) {
    lines.push('  (no stages recorded)');
  } else {
    for (const entry of stages) lines.push(formatStageLine(entry));
  }
  return lines.join('\n');
}

function dumpEscalation(label, escalationPath) {
  const lines = [`## escalation (${label}): ${escalationPath}`];
  if (!existsSync(escalationPath)) {
    lines.push('  (none)');
    return lines.join('\n');
  }
  const text = readFileSync(escalationPath, 'utf8');
  const head = text.split(/\r?\n/).slice(0, ESCALATION_HEAD_LINES);
  lines.push('  present — first 20 lines:');
  for (const line of head) lines.push(`  | ${line}`);
  return lines.join('\n');
}

function dumpGitState() {
  const lines = ['## git state (main)'];
  const log = run('git', ['log', '--oneline', '-2']);
  lines.push('- git log --oneline -2:');
  lines.push((log.stdout || '(no output)').trim().split('\n').map((l) => `  ${l}`).join('\n'));

  const worktrees = run('git', ['worktree', 'list']);
  const innerLines = (worktrees.stdout || '').split(/\r?\n/).filter((l) => l.includes('inner'));
  lines.push('- git worktree list | grep inner:');
  lines.push(innerLines.length > 0 ? innerLines.map((l) => `  ${l}`).join('\n') : '  (none)');

  const status = run('git', ['status', '--porcelain', '--untracked-files=no']);
  const dirty = (status.stdout || '').trim();
  lines.push('- git status --porcelain (tracked only, main-dirty check):');
  lines.push(dirty.length > 0 ? dirty.split('\n').map((l) => `  ${l}`).join('\n') : '  (clean)');

  return lines.join('\n');
}

export function dumpRunState(issueNumber) {
  const sections = [];
  sections.push(dumpManifest('issue', manifestPathFor(issueNumber)));
  sections.push(dumpManifest('plan', planManifestPathFor(issueNumber)));
  sections.push(dumpEscalation('issue', escalationPathFor(issueNumber)));
  sections.push(dumpEscalation('plan', planEscalationPathFor(issueNumber)));
  sections.push(dumpGitState());
  return sections.join('\n\n');
}

// --- main ----------------------------------------------------------------

function parseArgs(argv) {
  let issueNumber = null;
  let once = false;
  for (const arg of argv) {
    if (arg === '--once') {
      once = true;
    } else if (/^\d+$/.test(arg)) {
      issueNumber = Number(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (issueNumber == null) {
    throw new Error('usage: node tools/watch-run.mjs <issue#> [--once]');
  }
  return { issueNumber, once };
}

async function main(argv) {
  const { issueNumber, once } = parseArgs(argv);

  let pid = findRunPid(issueNumber, pgrepInnerLoop());
  if (pid == null) {
    process.stdout.write(`watch-run: no running inner-loop process found for issue #${issueNumber}.\n\n`);
    process.stdout.write(`${dumpRunState(issueNumber)}\n`);
    return;
  }

  process.stdout.write(`watch-run: found inner-loop pid ${pid} for issue #${issueNumber}.\n`);

  if (once) {
    process.stdout.write(`${dumpRunState(issueNumber)}\n`);
    return;
  }

  while (pidAlive(pid)) {
    process.stdout.write(`watch-run: pid ${pid} still running — polling again in ${POLL_INTERVAL_MS / 1000}s...\n`);
    await sleep(POLL_INTERVAL_MS);
  }

  process.stdout.write(`watch-run: pid ${pid} exited.\n\n`);
  process.stdout.write(`${dumpRunState(issueNumber)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`watch-run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
