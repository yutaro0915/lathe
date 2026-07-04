import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const ISSUE_JSON_FIELDS = 'number,title,body,labels,createdAt,closedAt';

type Format = 'json' | 'markdown';
export type GithubLabel = { name?: string | null };
export type GithubIssue = {
  number: number; title: string; body?: string | null; labels?: GithubLabel[] | null;
  createdAt?: string | null; closedAt?: string | null;
};
export type TouchComparison = {
  declaredTouches: string[]; actualPaths: string[]; missingActual: string[]; unusedDeclared: string[];
  precision: number | null; recall: number | null;
};
export type SimilarIssue = { issueNumber: number; title: string; signals: string[] };
export type IssueGrounding = TouchComparison & { issueNumber: number; title: string; similarIssues: SimilarIssue[] };
export type AdvisoryOpenOverlap = {
  leftIssueNumber: number; rightIssueNumber: number; leftPath: string; rightPath: string;
};
export type GroundingOkReport = {
  status: 'ok'; generatedAt: string; targetIssue: number | null;
  issues: IssueGrounding[]; advisoryOpenOverlaps: AdvisoryOpenOverlap[];
};
export type GroundingUnavailableReport = { status: 'unavailable'; generatedAt: string; reason: string };
export type GroundingReport = GroundingOkReport | GroundingUnavailableReport;
type CliArgs = { issueNumber: number | null; format: Format };
type ActualRowsByIssue = Map<number, string[]>;
type RunHints = { dependsOn: number[]; touches: string[] };
type QueueOverlap = (a: string, b: string) => boolean;
// Only pathsOverlap is shared with scripts/inner-queue.mjs now. Depends-on
// parsing for GitHub issue bodies (this file's own concern — Issues remain a
// report-only channel post ADR 0025, not Backlog.md tasks) has no home left
// in inner-queue.mjs (TASK-1.3 narrowed its exported parser to Touches-only,
// since task dependency resolution moved to `backlog sequence`), so it is
// self-contained here via fallbackParseIssueRunHints below.
type QueueHelpers = { pathsOverlap: QueueOverlap };
type PgPool = { query<T>(sql: string): Promise<{ rows: T[] }>; end(): Promise<void> };
type PgPoolConstructor = new (config: { connectionString: string; connectionTimeoutMillis: number }) => PgPool;

function fallbackParseIssueRunHints(body: string | null | undefined): RunHints {
  const dependsOn: number[] = [];
  const touches: string[] = [];
  const seenDeps = new Set<number>();
  const seenTouches = new Set<string>();
  const text = typeof body === 'string' ? body : '';

  for (const line of text.split(/\r?\n/)) {
    const depMatch = line.match(/^\s*depends-on\s*:\s*(.*)$/i);
    if (depMatch) {
      for (const match of depMatch[1].matchAll(/#(\d+)/g)) {
        const issueNumber = Number(match[1]);
        if (Number.isInteger(issueNumber) && issueNumber > 0 && !seenDeps.has(issueNumber)) {
          seenDeps.add(issueNumber);
          dependsOn.push(issueNumber);
        }
      }
      continue;
    }

    const touchesMatch = line.match(/^\s*touches\s*:\s*(.*)$/i);
    if (touchesMatch) {
      for (const raw of touchesMatch[1].split(',')) {
        const path = raw.trim();
        if (path && !seenTouches.has(path)) {
          seenTouches.add(path);
          touches.push(path);
        }
      }
    }
  }

  return { dependsOn, touches };
}

function normalizeTouchPath(path: string): string {
  const raw = String(path ?? '').trim().replaceAll('\\', '/');
  if (!raw) return '';
  let normalized = posix.normalize(raw);
  normalized = normalized.replace(/^(\.\/)+/, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function fallbackPathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = normalizeTouchPath(leftPath);
  const right = normalizeTouchPath(rightPath);
  if (!left || !right) return false;
  if (left === '.' || right === '.') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

let queueHelpers: QueueHelpers = {
  pathsOverlap: fallbackPathsOverlap,
};
let queueHelpersLoadedFromInnerQueue = false;

export async function loadQueueHelpers(): Promise<void> {
  if (queueHelpersLoadedFromInnerQueue) return;
  // @ts-ignore - repo-level ESM helper is JS-only but intentionally shared here.
  const module = await import('../../../scripts/inner-queue.mjs') as QueueHelpers;
  queueHelpers = {
    pathsOverlap: module.pathsOverlap,
  };
  queueHelpersLoadedFromInnerQueue = true;
}

function parseHints(body: string | null | undefined): RunHints {
  return fallbackParseIssueRunHints(body);
}

function touchPathsOverlap(left: string, right: string): boolean {
  return queueHelpers.pathsOverlap(left, right);
}

const STOP_TOKENS = new Set([
  'about', 'after', 'again', 'against', 'body', 'changed', 'depends', 'from', 'have',
  'inner', 'into', 'issue', 'loop', 'that', 'this', 'touches', 'with', 'workflow',
]);

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function countCovered(paths: string[], coveringPaths: string[]): number {
  return paths.filter((path) => coveringPaths.some((coveringPath) => touchPathsOverlap(path, coveringPath))).length;
}

export function compareTouches(declaredTouches: string[], actualPaths: string[]): TouchComparison {
  const declared = uniqueSorted(declaredTouches);
  const actual = uniqueSorted(actualPaths);
  const coveredDeclared = countCovered(declared, actual);
  const coveredActual = countCovered(actual, declared);

  return {
    declaredTouches: declared,
    actualPaths: actual,
    missingActual: actual.filter((path) => !declared.some((declaredPath) => touchPathsOverlap(path, declaredPath))),
    unusedDeclared: declared.filter((path) => !actual.some((actualPath) => touchPathsOverlap(path, actualPath))),
    precision: declared.length === 0 ? null : coveredDeclared / declared.length,
    recall: actual.length === 0 ? null : coveredActual / actual.length,
  };
}

export function makeUnavailableReport(reason: string, now = new Date()): GroundingUnavailableReport {
  return { status: 'unavailable', generatedAt: now.toISOString(), reason };
}

function issueLabels(issue: GithubIssue): string[] {
  return uniqueSorted((issue.labels ?? []).map((label) => label.name ?? '').filter((name) => name !== 'inner-loop'));
}

function titlePrefix(title: string): string {
  const normalized = title.toLowerCase().replace(/#[0-9]+/g, '').replace(/[^a-z0-9:]+/g, ' ').trim();
  const colonPrefix = normalized.split(':')[0]?.trim() ?? '';
  if (colonPrefix.length >= 4) return colonPrefix;
  return normalized.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
}

function bodyTokens(body: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const token of String(body ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (!STOP_TOKENS.has(token) && !/^[0-9]+$/.test(token)) tokens.add(token);
  }
  return tokens;
}

function sharedItems(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((item) => rightSet.has(item)).sort((a, b) => a.localeCompare(b));
}

function similarSignals(issue: GithubIssue, candidate: GithubIssue): string[] {
  const signals: string[] = [];
  const leftPrefix = titlePrefix(issue.title);
  const rightPrefix = titlePrefix(candidate.title);
  if (leftPrefix && leftPrefix === rightPrefix) signals.push(`title-prefix:${leftPrefix}`);

  for (const label of sharedItems(issueLabels(issue), issueLabels(candidate))) {
    signals.push(`shared-label:${label}`);
  }

  const sharedTokens = sharedItems(bodyTokens(issue.body), bodyTokens(candidate.body));
  if (sharedTokens.length >= 3) {
    signals.push(`body-tokens:${sharedTokens.slice(0, 5).join(',')}`);
  }

  return signals;
}

export function findSimilarIssues(issue: GithubIssue, allIssues: GithubIssue[]): SimilarIssue[] {
  return allIssues
    .filter((candidate) => candidate.number !== issue.number)
    .map((candidate) => ({
      issueNumber: candidate.number,
      title: candidate.title,
      signals: similarSignals(issue, candidate),
    }))
    .filter((candidate) => candidate.signals.length > 0)
    .sort((a, b) => a.issueNumber - b.issueNumber);
}

function historicalActualPaths(actualByIssue: ActualRowsByIssue, issueNumber: number): string[] {
  return actualByIssue.get(issueNumber) ?? [];
}

function issueOverlapPaths(issue: GithubIssue, actualByIssue: ActualRowsByIssue): string[] {
  const declared = parseHints(issue.body ?? '').touches;
  const actual = historicalActualPaths(actualByIssue, issue.number);
  return uniqueSorted([...declared, ...actual]);
}

function issueDependsOn(left: GithubIssue, right: GithubIssue): boolean {
  return parseHints(left.body ?? '').dependsOn.includes(right.number);
}

function firstOverlap(leftPaths: string[], rightPaths: string[]): { leftPath: string; rightPath: string } | null {
  for (const leftPath of leftPaths) {
    for (const rightPath of rightPaths) {
      if (touchPathsOverlap(leftPath, rightPath)) return { leftPath, rightPath };
    }
  }
  return null;
}

export function findAdvisoryOpenOverlaps(issues: GithubIssue[], actualByIssue: ActualRowsByIssue): AdvisoryOpenOverlap[] {
  const openIssues = issues.filter((issue) => !issue.closedAt).sort((a, b) => a.number - b.number);
  const overlaps: AdvisoryOpenOverlap[] = [];

  for (let i = 0; i < openIssues.length; i += 1) {
    for (let j = i + 1; j < openIssues.length; j += 1) {
      const left = openIssues[i];
      const right = openIssues[j];
      if (issueDependsOn(left, right) || issueDependsOn(right, left)) continue;

      const overlap = firstOverlap(issueOverlapPaths(left, actualByIssue), issueOverlapPaths(right, actualByIssue));
      if (overlap) {
        overlaps.push({
          leftIssueNumber: left.number,
          rightIssueNumber: right.number,
          leftPath: overlap.leftPath,
          rightPath: overlap.rightPath,
        });
      }
    }
  }

  return overlaps;
}

function mergeIssues(innerLoopIssues: GithubIssue[], targetIssue: GithubIssue | null): GithubIssue[] {
  const byNumber = new Map<number, GithubIssue>();
  for (const issue of innerLoopIssues) byNumber.set(issue.number, issue);
  if (targetIssue) byNumber.set(targetIssue.number, targetIssue);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function buildGroundingReport({
  innerLoopIssues,
  targetIssue = null,
  actualByIssue,
  now = new Date(),
}: { innerLoopIssues: GithubIssue[]; targetIssue?: GithubIssue | null; actualByIssue: ActualRowsByIssue; now?: Date }): GroundingOkReport {
  const allIssues = mergeIssues(innerLoopIssues, targetIssue);
  const reportIssues = targetIssue ? [targetIssue] : allIssues;

  return {
    status: 'ok',
    generatedAt: now.toISOString(),
    targetIssue: targetIssue?.number ?? null,
    issues: reportIssues.map((issue) => ({
      issueNumber: issue.number,
      title: issue.title,
      ...compareTouches(parseHints(issue.body ?? '').touches, historicalActualPaths(actualByIssue, issue.number)),
      similarIssues: findSimilarIssues(issue, allIssues),
    })),
    advisoryOpenOverlaps: findAdvisoryOpenOverlaps(allIssues, actualByIssue),
  };
}

function parseArgs(argv: string[]): CliArgs {
  let issueNumber: number | null = null;
  let format: Format = 'markdown';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--issue') {
      issueNumber = parseIssueNumber(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--issue=')) {
      issueNumber = parseIssueNumber(arg.slice('--issue='.length));
    } else if (arg === '--format') {
      format = parseFormat(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--format=')) {
      format = parseFormat(arg.slice('--format='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { issueNumber, format };
}

function parseIssueNumber(raw: string | undefined): number {
  const issueNumber = Number(raw);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('--issue must be a positive integer');
  }
  return issueNumber;
}

function parseFormat(raw: string | undefined): Format {
  if (raw === 'json' || raw === 'markdown') return raw;
  throw new Error('--format must be json or markdown');
}

function ghJson<T>(args: string[]): T {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status ?? 'null'}`).trim();
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
  return JSON.parse(result.stdout) as T;
}

function fetchInnerLoopIssues(): GithubIssue[] {
  return ghJson<GithubIssue[]>([
    'issue', 'list', '--state', 'all', '--label', 'inner-loop', '--json', ISSUE_JSON_FIELDS, '--limit', '200',
  ]);
}

function fetchIssue(issueNumber: number): GithubIssue {
  return ghJson<GithubIssue>(['issue', 'view', String(issueNumber), '--json', ISSUE_JSON_FIELDS]);
}

async function fetchActualChangedFiles(): Promise<ActualRowsByIssue> {
  const [{ Pool }, { getDatabaseUrl }] = await Promise.all([
    import('pg') as Promise<{ Pool: PgPoolConstructor }>,
    import('../lib/postgres') as Promise<{ getDatabaseUrl: () => string }>,
  ]);
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 2_000,
  });
  try {
    const result = await pool.query<{ issue_number: number; paths: string | null }>(`
      WITH inner_sessions AS (
        SELECT
          id,
          (regexp_match(git_branch, '^inner/issue-([0-9]+)$'))[1]::int AS issue_number
        FROM sessions
        WHERE git_branch ~ '^inner/issue-[0-9]+$'
      )
      SELECT
        inner_sessions.issue_number,
        string_agg(DISTINCT changed_files.path, E'\\n' ORDER BY changed_files.path) AS paths
      FROM inner_sessions
      JOIN changed_files ON changed_files.session_id = inner_sessions.id
      GROUP BY inner_sessions.issue_number
      ORDER BY inner_sessions.issue_number
    `);
    return new Map(
      result.rows.map((row) => [
        Number(row.issue_number),
        row.paths ? row.paths.split('\n').filter(Boolean) : [],
      ]),
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function buildLiveReport(issueNumber: number | null): Promise<GroundingReport> {
  try {
    await loadQueueHelpers();
    const innerLoopIssues = fetchInnerLoopIssues();
    const targetIssue = issueNumber === null ? null : fetchIssue(issueNumber);
    const actualByIssue = await fetchActualChangedFiles();
    return buildGroundingReport({ innerLoopIssues, targetIssue, actualByIssue });
  } catch (error) {
    return makeUnavailableReport(error instanceof Error ? error.message : String(error));
  }
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function formatList(values: string[]): string {
  if (values.length === 0) return '- none';
  return values.map((value) => `- \`${value}\``).join('\n');
}

export function formatMarkdown(report: GroundingReport): string {
  if (report.status === 'unavailable') {
    return ['# Touches Grounding', '', `grounding unavailable: ${report.reason}`, '', `generatedAt: ${report.generatedAt}`].join('\n');
  }

  const lines = [
    '# Touches Grounding',
    '',
    `status: ${report.status}`,
    `generatedAt: ${report.generatedAt}`,
    `targetIssue: ${report.targetIssue === null ? 'all inner-loop issues' : `#${report.targetIssue}`}`,
  ];

  for (const issue of report.issues) {
    lines.push(
      '',
      `## #${issue.issueNumber} ${issue.title}`,
      '',
      `precision: ${formatRatio(issue.precision)}`,
      `recall: ${formatRatio(issue.recall)}`,
      '',
      'Declared Touches:',
      formatList(issue.declaredTouches),
      '',
      'Actual changed_files:',
      formatList(issue.actualPaths),
      '',
      'Missing actual paths:',
      formatList(issue.missingActual),
      '',
      'Unused declared paths:',
      formatList(issue.unusedDeclared),
      '',
      'Similar issues (advisory):',
      issue.similarIssues.length === 0
        ? '- none'
        : issue.similarIssues
            .map((similar) => `- #${similar.issueNumber} ${similar.title} (${similar.signals.join('; ')})`)
            .join('\n'),
    );
  }

  lines.push('', '## Advisory Open Overlaps', '');
  lines.push(
    report.advisoryOpenOverlaps.length === 0
      ? '- none'
      : report.advisoryOpenOverlaps
          .map(
            (overlap) =>
              `- #${overlap.leftIssueNumber} \`${overlap.leftPath}\` overlaps #${overlap.rightIssueNumber} \`${overlap.rightPath}\``,
          )
          .join('\n'),
  );

  return lines.join('\n');
}

function formatJson(report: GroundingReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatReport(report: GroundingReport, format: Format): string {
  return format === 'json' ? formatJson(report) : `${formatMarkdown(report)}\n`;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`touches-grounding: ${error instanceof Error ? error.message : String(error)}`);
    console.error('usage: pnpm -C apps/web exec tsx scripts/touches-grounding.ts [--issue N] [--format json|markdown]');
    return 2;
  }

  const report = await buildLiveReport(args.issueNumber);
  process.stdout.write(formatReport(report, args.format));
  return 0;
}

const _isMain = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
  } catch {
    return false;
  }
})();

if (_isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stdout.write(formatReport(makeUnavailableReport(error instanceof Error ? error.message : String(error)), 'markdown'));
      process.exitCode = 0;
    });
}
