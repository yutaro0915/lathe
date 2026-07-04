#!/usr/bin/env node
// tools/wbs.mjs — WBS 盤面の live 生成（ADR 0017 tool-loop 初弾 1/2, v2）
//
// gh issues（inner-loop / needs-plan / pending-approval ラベル + 全 issue 状態）と
// .lathe/runs/*.json（driver の manifest）・git worktree list（実行中 run）・
// .lathe/wbs/tasks.json（ローカル自前タスク）から統合 WBS 盤面を端末に出す。
//
// 通常の board 表示は read-only。task サブコマンドだけが .lathe/wbs/tasks.json を書く。
// repo の追跡ファイル・DB・git 状態は変更しない。
//
// Usage:
//   node tools/wbs.mjs                         端末向け統合テキスト盤面
//   node tools/wbs.mjs --json                  機械可読ダンプ
//   node tools/wbs.mjs task list               ローカルタスク一覧
//   node tools/wbs.mjs task add <id> --title "..." [--desc "..."] [--phase "..."] [--depends "#12,task:foo"]
//   node tools/wbs.mjs task doing <id>         status=doing
//   node tools/wbs.mjs task done <id>          status=done
//   node tools/wbs.mjs task status <id> <status>

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);

export const DEFAULT_TASKS_PATH = join(REPO_ROOT, '.lathe', 'wbs', 'tasks.json');

const RECENT_DONE_LIMIT = 12;
const TITLE_MAX = 72;
const SUMMARY_MAX = 140;
const UNPHASED = 'Unphased';
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SECTION_DEFS = [
  ['running', 'RUNNING', 'running'],
  ['pendingApproval', 'PENDING_APPROVAL', 'pending_approval'],
  ['ready', 'READY', 'ready'],
  ['waitDep', 'WAIT_DEP', 'wait_dep'],
  ['needsPlan', 'NEEDS-PLAN', 'needs_plan'],
  ['unqueued', 'UNQUEUED', 'unqueued'],
  ['doneRecent', 'DONE (recent)', 'done_recent'],
];

const TERMINAL_STAGE_BY_KIND = { impl: 'MERGE', plan: 'CLOSE_SOURCE' };

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
  const out = run('gh', ['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels,body,milestone']);
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

function extractBodyField(body, fieldName) {
  const re = new RegExp(`^\\s*${fieldName}\\s*:\\s*(.*)$`, 'i');
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = line.match(re);
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

function labelNames(issue) {
  return Array.isArray(issue.labels) ? issue.labels.map((l) => l?.name).filter(Boolean) : [];
}

function truncateText(value, limit) {
  const t = String(value ?? '');
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

function truncateTitle(title) {
  return truncateText(title, TITLE_MAX);
}

function manifestIsOpen(manifest) {
  if (!manifest) return false;
  if (manifest.lastStage == null) return false;
  const terminalStage = TERMINAL_STAGE_BY_KIND[manifest.kind] ?? 'MERGE';
  if (manifest.lastStage === terminalStage && manifest.lastVerdict != null && manifest.lastVerdict !== 'ESCALATE') {
    return false;
  }
  return true;
}

// --- local task store -----------------------------------------------------

export function createEmptyTaskStore() {
  return { version: 1, tasks: [] };
}

function normalizeTaskStatus(status) {
  const normalized = String(status ?? 'todo').trim().toLowerCase();
  if (!normalized) throw new Error('task status must not be empty');
  return normalized;
}

function normalizePhase(phase) {
  const normalized = String(phase ?? '').trim();
  return normalized || null;
}

function assertTaskId(id) {
  const normalized = String(id ?? '').trim();
  if (!TASK_ID_RE.test(normalized)) {
    throw new Error(`invalid task id: ${id ?? ''}`);
  }
  return normalized;
}

function normalizeDependencyRef(rawRef) {
  const token = String(rawRef ?? '').trim().replace(/[.;]+$/, '');
  if (!token) return null;

  let match = token.match(/^#(\d+)$/);
  if (match) return `issue:${Number(match[1])}`;

  match = token.match(/^(?:issue|gh):#?(\d+)$/i);
  if (match) return `issue:${Number(match[1])}`;

  if (/^\d+$/.test(token)) return `issue:${Number(token)}`;

  match = token.match(/^task:([A-Za-z0-9][A-Za-z0-9._-]*)$/i);
  if (match) return `task:${match[1]}`;

  if (TASK_ID_RE.test(token)) return `task:${token}`;

  throw new Error(`invalid dependency ref: ${token}`);
}

export function parseDependencyRefs(rawValues = []) {
  const refs = [];
  const seen = new Set();
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  for (const raw of values) {
    for (const token of String(raw ?? '').split(/[,\s]+/)) {
      const ref = normalizeDependencyRef(token);
      if (ref && !seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  return refs;
}

function normalizeLocalTask(rawTask) {
  const id = assertTaskId(rawTask?.id);
  const title = String(rawTask?.title ?? '').trim();
  if (!title) throw new Error(`task ${id} is missing title`);
  const description = String(rawTask?.description ?? rawTask?.desc ?? '').trim();
  return {
    id,
    title,
    description,
    status: normalizeTaskStatus(rawTask?.status),
    phase: normalizePhase(rawTask?.phase),
    deps: parseDependencyRefs(rawTask?.deps ?? rawTask?.dependencies ?? []),
    createdAt: rawTask?.createdAt ?? null,
    updatedAt: rawTask?.updatedAt ?? null,
  };
}

function normalizeTaskStore(rawStore) {
  const tasks = Array.isArray(rawStore)
    ? rawStore
    : Array.isArray(rawStore?.tasks)
      ? rawStore.tasks
      : [];
  const normalized = createEmptyTaskStore();
  normalized.tasks = tasks.map(normalizeLocalTask);
  return normalized;
}

export function loadTaskStore(taskFilePath = DEFAULT_TASKS_PATH) {
  if (!existsSync(taskFilePath)) return createEmptyTaskStore();
  try {
    return normalizeTaskStore(JSON.parse(readFileSync(taskFilePath, 'utf8')));
  } catch (err) {
    throw new Error(`could not read ${taskFilePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function saveTaskStore(taskFilePath = DEFAULT_TASKS_PATH, store) {
  const normalized = normalizeTaskStore(store);
  const dir = dirname(taskFilePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `${basename(taskFilePath)}.${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, taskFilePath);
  return normalized;
}

export function addLocalTask(store, input) {
  const current = normalizeTaskStore(store);
  const now = input?.now ?? new Date().toISOString();
  const task = normalizeLocalTask({
    ...input,
    createdAt: input?.createdAt ?? now,
    updatedAt: input?.updatedAt ?? now,
  });
  if (current.tasks.some((t) => t.id === task.id)) {
    throw new Error(`task id already exists: ${task.id}`);
  }
  return { version: 1, tasks: [...current.tasks, task] };
}

export function setLocalTaskStatus(store, id, status, now = new Date().toISOString()) {
  const current = normalizeTaskStore(store);
  const taskId = assertTaskId(id);
  let found = false;
  const tasks = current.tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return { ...task, status: normalizeTaskStatus(status), updatedAt: now };
  });
  if (!found) throw new Error(`unknown task id: ${taskId}`);
  return { version: 1, tasks };
}

// --- classification -------------------------------------------------------

function emptyFlatSections() {
  return Object.fromEntries(SECTION_DEFS.map(([key]) => [key, []]));
}

function statusIn(status, names) {
  return names.has(normalizeTaskStatus(status));
}

function isDoingStatus(status) {
  return statusIn(status, new Set(['doing', 'in-progress', 'running', 'active']));
}

function isDoneStatus(status) {
  return statusIn(status, new Set(['done', 'closed', 'complete', 'completed']));
}

function isReadyStatus(status) {
  return statusIn(status, new Set(['todo', 'ready', 'open']));
}

function isWaitingStatus(status) {
  return statusIn(status, new Set(['blocked', 'waiting', 'wait', 'hold', 'deferred']));
}

function isNeedsPlanStatus(status) {
  return statusIn(status, new Set(['needs-plan', 'needs_plan', 'planning']));
}

function isPendingApprovalStatus(status) {
  return statusIn(status, new Set(['pending-approval', 'pending_approval', 'approval']));
}

function stripMarkdown(line) {
  return String(line ?? '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

function bodySummary(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\s*#{1,6}\s+/.test(trimmed)) continue;
    if (/^\s*(Depends-on|Phase)\s*:/i.test(trimmed)) continue;
    const stripped = stripMarkdown(trimmed);
    if (stripped) return truncateText(stripped, SUMMARY_MAX);
  }
  return null;
}

function issueSummary(issue) {
  return bodySummary(issue.body) ?? truncateText(issue.title, SUMMARY_MAX);
}

function taskSummary(task) {
  return truncateText(task.description || task.title, SUMMARY_MAX);
}

function issuePhase(issue) {
  const bodyPhase = extractBodyField(issue.body, 'Phase');
  const labelPhase = labelNames(issue)
    .map((name) => {
      let match = String(name).match(/^phase\s*[:/]\s*(.+)$/i);
      if (match) return match[1].trim();
      match = String(name).match(/^phase-(.+)$/i);
      return match ? match[1].trim() : null;
    })
    .find(Boolean);
  return normalizePhase(bodyPhase ?? labelPhase ?? issue?.milestone?.title) ?? UNPHASED;
}

function taskPhase(task) {
  return normalizePhase(task.phase) ?? UNPHASED;
}

function issueItem(issue, extra = {}) {
  return {
    kind: 'issue',
    ref: `issue:${issue.number}`,
    number: issue.number,
    title: String(issue.title ?? ''),
    state: issue.state,
    status: String(issue.state ?? '').toLowerCase(),
    labels: labelNames(issue),
    phase: issuePhase(issue),
    summary: issueSummary(issue),
    ...extra,
  };
}

function taskItem(task, extra = {}) {
  return {
    kind: 'task',
    ref: `task:${task.id}`,
    id: task.id,
    title: task.title,
    status: task.status,
    phase: taskPhase(task),
    summary: taskSummary(task),
    deps: task.deps,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...extra,
  };
}

function unresolvedTaskDeps(task, closedIssueRefs, doneTaskRefs) {
  return task.deps.filter((ref) => {
    if (ref.startsWith('issue:')) return !closedIssueRefs.has(ref);
    if (ref.startsWith('task:')) return !doneTaskRefs.has(ref);
    return true;
  });
}

function compareDone(a, b) {
  if (a.kind === 'issue' && b.kind === 'issue') return b.number - a.number;
  const aTime = a.updatedAt ?? a.createdAt ?? '';
  const bTime = b.updatedAt ?? b.createdAt ?? '';
  if (aTime !== bTime) return String(bTime).localeCompare(String(aTime));
  return a.ref.localeCompare(b.ref);
}

function buildPhaseView(flat) {
  const phaseMap = new Map();
  for (const [sectionKey] of SECTION_DEFS) {
    for (const item of flat[sectionKey]) {
      if (!phaseMap.has(item.phase)) {
        phaseMap.set(item.phase, {
          phase: item.phase,
          sections: emptyFlatSections(),
        });
      }
      phaseMap.get(item.phase).sections[sectionKey].push(item);
    }
  }
  return [...phaseMap.values()];
}

function totalsFor(flat) {
  return Object.fromEntries(SECTION_DEFS.map(([key]) => [key, flat[key].length]));
}

export function classifyItems({ issues = [], localTasks = [], runningWorktrees = new Map(), manifests = new Map() }) {
  const flat = emptyFlatSections();
  const closedNumbers = new Set(issues.filter((i) => i.state === 'CLOSED').map((i) => i.number));
  const closedIssueRefs = new Set([...closedNumbers].map((n) => `issue:${n}`));
  const tasks = normalizeTaskStore({ version: 1, tasks: localTasks }).tasks;
  const doneTaskRefs = new Set(tasks.filter((task) => isDoneStatus(task.status)).map((task) => `task:${task.id}`));

  for (const issue of issues) {
    const isOpen = issue.state === 'OPEN';
    const inRunningWorktree = runningWorktrees.has(issue.number);
    const manifest = manifests.get(issue.number);
    const inOpenManifest = isOpen && manifestIsOpen(manifest);

    if (isOpen && (inRunningWorktree || inOpenManifest)) {
      flat.running.push(issueItem(issue, {
        worktreePath: runningWorktrees.get(issue.number) ?? null,
        manifest: manifest ?? null,
      }));
      continue;
    }

    if (!isOpen) {
      flat.doneRecent.push(issueItem(issue));
      continue;
    }

    if (hasLabel(issue, 'pending-approval')) {
      flat.pendingApproval.push(issueItem(issue));
      continue;
    }

    if (hasLabel(issue, 'inner-loop')) {
      const dependsOnRaw = extractDependsOnLine(issue.body);
      const dependsOnNumbers = parseDependsOn(dependsOnRaw);
      const waitingOn = dependsOnNumbers.filter((n) => !closedNumbers.has(n)).map((n) => `issue:${n}`);
      if (waitingOn.length > 0) {
        flat.waitDep.push(issueItem(issue, { waitingOn }));
      } else {
        flat.ready.push(issueItem(issue));
      }
      continue;
    }

    if (hasLabel(issue, 'needs-plan')) {
      flat.needsPlan.push(issueItem(issue));
      continue;
    }

    flat.unqueued.push(issueItem(issue));
  }

  for (const task of tasks) {
    if (isDoingStatus(task.status)) {
      flat.running.push(taskItem(task));
      continue;
    }

    if (isDoneStatus(task.status)) {
      flat.doneRecent.push(taskItem(task));
      continue;
    }

    if (isPendingApprovalStatus(task.status)) {
      flat.pendingApproval.push(taskItem(task));
      continue;
    }

    if (isNeedsPlanStatus(task.status)) {
      flat.needsPlan.push(taskItem(task));
      continue;
    }

    const waitingOn = unresolvedTaskDeps(task, closedIssueRefs, doneTaskRefs);
    if (isWaitingStatus(task.status)) {
      flat.waitDep.push(taskItem(task, { waitingOn }));
      continue;
    }

    if (isReadyStatus(task.status)) {
      if (waitingOn.length > 0) {
        flat.waitDep.push(taskItem(task, { waitingOn }));
      } else {
        flat.ready.push(taskItem(task));
      }
      continue;
    }

    flat.unqueued.push(taskItem(task));
  }

  flat.doneRecent.sort(compareDone);
  flat.doneRecent = flat.doneRecent.slice(0, RECENT_DONE_LIMIT);

  const phases = buildPhaseView(flat);
  return { phases, totals: totalsFor(flat), ...flat };
}

export function classifyIssues({ issues, runningWorktrees, manifests }) {
  return classifyItems({ issues, localTasks: [], runningWorktrees, manifests });
}

// --- rendering -------------------------------------------------------------

function formatItemLine(item) {
  const extras = [];
  if (item.kind === 'task') extras.push(`status: ${item.status}`);
  if (item.worktreePath) extras.push(`worktree: ${basename(item.worktreePath)}`);
  if (!item.worktreePath && item.manifest) extras.push('manifest open');
  if (Array.isArray(item.waitingOn) && item.waitingOn.length > 0) extras.push(`依存: ${item.waitingOn.join(', ')}`);
  const suffix = extras.length > 0 ? ` [${extras.join('; ')}]` : '';
  return `${item.ref} ${truncateTitle(item.title)}${suffix}`;
}

function renderSection(title, rows) {
  const lines = [`### ${title} (${rows.length})`];
  if (rows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of rows) {
      lines.push(`  - ${formatItemLine(item)}`);
      if (item.summary) lines.push(`    つまり: ${truncateText(item.summary, SUMMARY_MAX)}`);
    }
  }
  return lines.join('\n');
}

function renderTotals(totals) {
  return SECTION_DEFS
    .map(([key, title]) => `${title} ${totals[key] ?? 0}`)
    .join(' | ');
}

export function renderBoard(classification) {
  const phases = Array.isArray(classification?.phases) ? classification.phases : [];
  const totals = classification?.totals ?? totalsFor(classification ?? emptyFlatSections());
  const lines = ['# WBS', renderTotals(totals)];

  if (phases.length === 0) {
    lines.push('', `## Phase: ${UNPHASED}`);
    for (const [sectionKey, title] of SECTION_DEFS) {
      lines.push(renderSection(title, []));
    }
    return lines.join('\n');
  }

  for (const phase of phases) {
    lines.push('', `## Phase: ${phase.phase}`);
    for (const [sectionKey, title] of SECTION_DEFS) {
      lines.push(renderSection(title, phase.sections[sectionKey] ?? []));
    }
  }

  return lines.join('\n');
}

function stripItem(item) {
  const stripped = {
    kind: item.kind,
    ref: item.ref,
    title: item.title,
    status: item.status,
    phase: item.phase,
    summary: item.summary,
  };
  if (item.kind === 'issue') {
    stripped.number = item.number;
    stripped.state = item.state;
    stripped.labels = item.labels;
  } else {
    stripped.id = item.id;
    stripped.deps = item.deps;
    stripped.createdAt = item.createdAt;
    stripped.updatedAt = item.updatedAt;
  }
  if (item.worktreePath) stripped.worktreePath = item.worktreePath;
  if (item.manifest) stripped.manifest = item.manifest;
  if (item.waitingOn) stripped.waitingOn = item.waitingOn;
  return stripped;
}

export function toJson(classification) {
  const json = {
    totals: classification.totals,
    phases: classification.phases.map((phase) => ({
      phase: phase.phase,
      sections: Object.fromEntries(SECTION_DEFS.map(([key, , jsonKey]) => [
        jsonKey,
        (phase.sections[key] ?? []).map(stripItem),
      ])),
    })),
  };

  for (const [key, , jsonKey] of SECTION_DEFS) {
    json[jsonKey] = (classification[key] ?? []).map(stripItem);
  }

  return json;
}

export function renderTaskList(store) {
  const tasks = normalizeTaskStore(store).tasks;
  if (tasks.length === 0) return '(no local tasks)';
  const lines = [];
  for (const task of tasks) {
    const phase = task.phase ? ` phase="${task.phase}"` : '';
    const deps = task.deps.length > 0 ? ` deps=${task.deps.join(',')}` : '';
    lines.push(`task:${task.id} [${task.status}] ${task.title}${phase}${deps}`);
    if (task.description) lines.push(`  ${task.description}`);
  }
  return lines.join('\n');
}

// --- CLI ------------------------------------------------------------------

function usage() {
  return [
    'usage:',
    '  node tools/wbs.mjs [--json] [--tasks <path>]',
    '  node tools/wbs.mjs task list [--json] [--file <path>]',
    '  node tools/wbs.mjs task add <id> --title <title> [--desc <text>] [--status <status>] [--phase <phase>] [--depends <refs>] [--file <path>]',
    '  node tools/wbs.mjs task status <id> <status> [--file <path>]',
    '  node tools/wbs.mjs task todo|doing|done <id> [--file <path>]',
  ].join('\n');
}

function readFlagValue(args, index, arg) {
  const equals = arg.indexOf('=');
  if (equals !== -1) return { value: arg.slice(equals + 1), nextIndex: index + 1 };
  if (index + 1 >= args.length) throw new Error(`missing value for ${arg}`);
  return { value: args[index + 1], nextIndex: index + 2 };
}

function parseOptions(args) {
  const opts = { positionals: [], deps: [] };
  for (let i = 0; i < args.length;) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      opts.positionals.push(arg);
      i += 1;
      continue;
    }

    if (arg === '--json') {
      opts.json = true;
      i += 1;
      continue;
    }

    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readFlagValue(args, i, arg);
    if (flag === '--title') opts.title = value;
    else if (flag === '--desc' || flag === '--description') opts.description = value;
    else if (flag === '--status') opts.status = value;
    else if (flag === '--phase') opts.phase = value;
    else if (flag === '--depends' || flag === '--depends-on' || flag === '--dep') opts.deps.push(value);
    else if (flag === '--file' || flag === '--tasks') opts.file = value;
    else throw new Error(`unknown flag: ${flag}`);
    i = nextIndex;
  }
  return opts;
}

function taskFileFrom(opts) {
  return opts.file ?? DEFAULT_TASKS_PATH;
}

function runTaskCommand(argv, streams = {}) {
  const stdout = streams.stdout ?? process.stdout;
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    stdout.write(`${usage()}\n`);
    return;
  }

  const opts = parseOptions(rest);
  const taskFilePath = taskFileFrom(opts);

  if (command === 'list') {
    const store = loadTaskStore(taskFilePath);
    stdout.write(opts.json ? `${JSON.stringify(store, null, 2)}\n` : `${renderTaskList(store)}\n`);
    return;
  }

  if (command === 'add') {
    const id = opts.positionals[0];
    if (!id) throw new Error('task add requires <id>');
    if (!opts.title) throw new Error('task add requires --title <title>');
    const next = addLocalTask(loadTaskStore(taskFilePath), {
      id,
      title: opts.title,
      description: opts.description ?? '',
      status: opts.status ?? 'todo',
      phase: opts.phase ?? null,
      deps: opts.deps,
    });
    saveTaskStore(taskFilePath, next);
    stdout.write(`wbs task add: created task:${id}\n`);
    return;
  }

  const statusAliases = new Map([
    ['todo', 'todo'],
    ['doing', 'doing'],
    ['done', 'done'],
  ]);
  if (statusAliases.has(command)) {
    const id = opts.positionals[0];
    if (!id) throw new Error(`task ${command} requires <id>`);
    const next = setLocalTaskStatus(loadTaskStore(taskFilePath), id, statusAliases.get(command));
    saveTaskStore(taskFilePath, next);
    stdout.write(`wbs task ${command}: task:${id}\n`);
    return;
  }

  if (command === 'status') {
    const [id, status] = opts.positionals;
    if (!id || !status) throw new Error('task status requires <id> <status>');
    const next = setLocalTaskStatus(loadTaskStore(taskFilePath), id, status);
    saveTaskStore(taskFilePath, next);
    stdout.write(`wbs task status: task:${id} -> ${normalizeTaskStatus(status)}\n`);
    return;
  }

  throw new Error(`unknown task command: ${command}`);
}

function parseBoardArgs(argv) {
  const opts = parseOptions(argv);
  if (opts.positionals.length > 0) throw new Error(`unknown argument: ${opts.positionals[0]}`);
  return { asJson: Boolean(opts.json), tasksFilePath: taskFileFrom(opts) };
}

function main(argv) {
  if (argv[0] === 'task') {
    runTaskCommand(argv.slice(1));
    return;
  }

  const { asJson, tasksFilePath } = parseBoardArgs(argv);
  const issues = fetchIssues();
  const runningWorktrees = parseRunningWorktrees(fetchWorktreeListing());
  const manifests = readRunManifests(join(REPO_ROOT, '.lathe', 'runs'));
  const localTasks = loadTaskStore(tasksFilePath).tasks;

  const classification = classifyItems({ issues, localTasks, runningWorktrees, manifests });

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
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
}
