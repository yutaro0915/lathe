#!/usr/bin/env node
// tools/wbs.mjs — WBS 盤面の live 生成（ADR 0017 tool-loop 初弾 1/2）
//
// gh issues（inner-loop / needs-plan ラベル + 全 issue 状態）と
// .lathe/runs/*.json（driver の manifest）・git worktree list（実行中 run）から
// issue を状態別に整理した盤面を端末に出す。read-only（repo 状態・DB・git を変更しない）。
//
// Usage:
//   node tools/wbs.mjs           端末向けテキスト盤面
//   node tools/wbs.mjs --json    機械可読ダンプ（同じ分類データを JSON で出す）

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);

const RECENT_DONE_LIMIT = 12;
const TITLE_MAX = 72;

// --- gh / git shell-outs -----------------------------------------------

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
  if (result.error) {
    throw new Error(`${cmd} ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

function fetchIssues() {
  const out = run('gh', ['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels,body']);
  return JSON.parse(out);
}

function fetchWorktreeListing() {
  return run('git', ['worktree', 'list', '--porcelain']);
}

// --- parsing helpers -----------------------------------------------------

// Extract issue numbers running under inner-issue-<N> worktrees.
// Mirrors scripts/inner-queue.mjs#parseInnerIssueWorktrees (kept independent —
// tools/ is a carve-out and intentionally does not import from scripts/).
export function parseRunningWorktrees(porcelainOutput) {
  const running = new Map();
  for (const line of String(porcelainOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/);
    if (!match) continue;
    const worktreePath = match[1].trim();
    const issueMatch = basename(worktreePath).match(/^inner-issue-(\d+)$/);
    if (!issueMatch) continue;
    const issueNumber = Number(issueMatch[1]);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      running.set(issueNumber, worktreePath);
    }
  }
  return running;
}

// Mirrors scripts/inner-loop-backends.mjs#parseDependsOnLine's contract:
// "none" (case-insensitive) or empty means no dependencies.
export function parseDependsOn(rawValue) {
  if (rawValue == null) return [];
  const trimmed = String(rawValue).trim();
  if (trimmed.length === 0 || /^none$/i.test(trimmed)) return [];
  const numbers = [];
  const re = /#(\d+)/g;
  let match;
  while ((match = re.exec(trimmed)) !== null) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

export function extractDependsOnLine(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*Depends-on\s*:\s*(.*)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

// Read .lathe/runs/issue-<N>.json manifests, return Map<issueNumber, { stages, lastStage, lastVerdict }>.
export function readRunManifests(runsDir) {
  const manifests = new Map();
  if (!existsSync(runsDir)) return manifests;
  let entries = [];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return manifests;
  }
  for (const entry of entries) {
    // impl-loop manifests: issue-<N>.json (terminal stage MERGE).
    // plan-loop manifests: plan-<N>.json (terminal stage CLOSE_SOURCE) — <N> is
    // the source (needs-plan) issue number, which stays OPEN until plan-loop finishes.
    const implMatch = entry.match(/^issue-(\d+)\.json$/);
    const planMatch = entry.match(/^plan-(\d+)\.json$/);
    const match = implMatch ?? planMatch;
    if (!match) continue;
    const issueNumber = Number(match[1]);
    const kind = implMatch ? 'impl' : 'plan';
    try {
      const data = JSON.parse(readFileSync(join(runsDir, entry), 'utf8'));
      const stages = Array.isArray(data.stages) ? data.stages : [];
      const last = stages.length > 0 ? stages[stages.length - 1] : null;
      manifests.set(issueNumber, {
        kind,
        stages,
        lastStage: last?.stage ?? null,
        lastVerdict: last?.verdict ?? null,
      });
    } catch {
      manifests.set(issueNumber, { kind, stages: [], lastStage: null, lastVerdict: null, unreadable: true });
    }
  }
  return manifests;
}

function hasLabel(issue, name) {
  return Array.isArray(issue.labels) && issue.labels.some((l) => l?.name === name);
}

function truncateTitle(title) {
  const t = String(title ?? '');
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

// A manifest run is considered "not closed" (i.e. still in flight from the
// driver's perspective) when its last recorded stage isn't a completed
// terminal stage: MERGE for impl-loop, CLOSE_SOURCE for plan-loop.
const TERMINAL_STAGE_BY_KIND = { impl: 'MERGE', plan: 'CLOSE_SOURCE' };
function manifestIsOpen(manifest) {
  if (!manifest) return false;
  if (manifest.lastStage == null) return false;
  const terminalStage = TERMINAL_STAGE_BY_KIND[manifest.kind] ?? 'MERGE';
  if (manifest.lastStage === terminalStage && manifest.lastVerdict != null && manifest.lastVerdict !== 'ESCALATE') {
    return false;
  }
  return true;
}

// --- classification -------------------------------------------------------

export function classifyIssues({ issues, runningWorktrees, manifests }) {
  const closedNumbers = new Set(issues.filter((i) => i.state === 'CLOSED').map((i) => i.number));

  const running = [];
  const ready = [];
  const waitDep = [];
  const needsPlan = [];
  const unqueued = [];
  const doneRecent = [];

  for (const issue of issues) {
    const isOpen = issue.state === 'OPEN';
    const inRunningWorktree = runningWorktrees.has(issue.number);
    const manifest = manifests.get(issue.number);
    const inOpenManifest = isOpen && manifestIsOpen(manifest);

    if (isOpen && (inRunningWorktree || inOpenManifest)) {
      running.push({ issue, worktreePath: runningWorktrees.get(issue.number) ?? null, manifest: manifest ?? null });
      continue;
    }

    if (!isOpen) {
      continue; // handled in the DONE pass below
    }

    if (hasLabel(issue, 'inner-loop')) {
      const dependsOnRaw = extractDependsOnLine(issue.body);
      const dependsOnNumbers = parseDependsOn(dependsOnRaw);
      const stillOpen = dependsOnNumbers.filter((n) => !closedNumbers.has(n));
      if (stillOpen.length > 0) {
        waitDep.push({ issue, waitingOn: stillOpen });
      } else {
        ready.push({ issue });
      }
      continue;
    }

    if (hasLabel(issue, 'needs-plan')) {
      needsPlan.push({ issue });
      continue;
    }

    unqueued.push({ issue });
  }

  const closedIssues = issues
    .filter((i) => i.state === 'CLOSED')
    .sort((a, b) => b.number - a.number)
    .slice(0, RECENT_DONE_LIMIT);
  for (const issue of closedIssues) doneRecent.push({ issue });

  return { running, ready, waitDep, needsPlan, unqueued, doneRecent };
}

// --- rendering -------------------------------------------------------------

function formatIssueLine(issue, extra) {
  const label = extra ? ` ${extra}` : '';
  return `#${issue.number} ${truncateTitle(issue.title)}${label}`;
}

function renderSection(title, rows) {
  const lines = [`## ${title} (${rows.length})`];
  if (rows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const row of rows) lines.push(`  ${row}`);
  }
  return lines.join('\n');
}

export function renderBoard(classification) {
  const sections = [];

  sections.push(renderSection('RUNNING', classification.running.map(({ issue, worktreePath }) =>
    formatIssueLine(issue, worktreePath ? `[worktree: ${basename(worktreePath)}]` : '[manifest open]'))));

  sections.push(renderSection('READY', classification.ready.map(({ issue }) => formatIssueLine(issue))));

  sections.push(renderSection('WAIT_DEP', classification.waitDep.map(({ issue, waitingOn }) =>
    formatIssueLine(issue, `[依存: ${waitingOn.map((n) => `#${n}`).join(', ')}]`))));

  sections.push(renderSection('NEEDS-PLAN', classification.needsPlan.map(({ issue }) => formatIssueLine(issue))));

  sections.push(renderSection('UNQUEUED', classification.unqueued.map(({ issue }) => formatIssueLine(issue))));

  sections.push(renderSection('DONE (recent)', classification.doneRecent.map(({ issue }) => formatIssueLine(issue))));

  return sections.join('\n\n');
}

function toJson(classification) {
  const strip = ({ issue, ...rest }) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    ...rest,
  });
  return {
    running: classification.running.map(strip),
    ready: classification.ready.map(strip),
    wait_dep: classification.waitDep.map(strip),
    needs_plan: classification.needsPlan.map(strip),
    unqueued: classification.unqueued.map(strip),
    done_recent: classification.doneRecent.map(strip),
  };
}

// --- main --------------------------------------------------------------

function main(argv) {
  const asJson = argv.includes('--json');

  const issues = fetchIssues();
  const runningWorktrees = parseRunningWorktrees(fetchWorktreeListing());
  const manifests = readRunManifests(join(REPO_ROOT, '.lathe', 'runs'));

  const classification = classifyIssues({ issues, runningWorktrees, manifests });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(toJson(classification), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderBoard(classification)}\n`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wbs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
