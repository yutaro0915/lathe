import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Format = 'json' | 'markdown';
type JsonObject = Record<string, unknown>;
type QueryRows = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
type Deps = {
  readFile?: (path: string) => string;
  queryRows?: QueryRows;
  now?: () => Date;
};

type ManifestStage = {
  stage?: unknown;
  session_id?: unknown;
  verdict?: unknown;
  backend?: unknown;
  backend_cost_usd?: unknown;
  backend_cost_source?: unknown;
  cost_usd?: unknown;
};

type Manifest = { issue?: unknown; stages?: unknown };

type SessionCostRow = { id: string; cost_usd: number | string | null };
type ChildCostRow = { session_id: string; cost_usd: number | string | null; child_count: number | string };
type LauncherCostRow = { session_id: string; cost_usd: number | string | null; launcher_count: number | string };

export type StageCostReport = {
  stage: string;
  session_id: string | null;
  verdict: string | null;
  backend: string | null;
  db_status: 'ok' | 'missing' | 'no_session_id';
  stage_session_cost_usd: number | null;
  stage_session_cost_source: 'db.sessions.cost_usd' | null;
  backend_cost_usd: number | null;
  backend_cost_source: string | null;
  legacy_backend_cost_usd: number | null;
  linked_child_sessions_cost_usd: number | null;
  linked_child_sessions_count: number;
  launcher_meta_subagent_cost_usd: number | null;
  launcher_meta_subagent_count: number;
  delta_backend_vs_db_session_usd: number | null;
  ratio_backend_vs_db_session: number | null;
};

export type RunManifestCostOkReport = {
  status: 'ok';
  generatedAt: string;
  manifestPath: string;
  issue: number | null;
  stages: StageCostReport[];
};

export type RunManifestCostUnavailableReport = {
  status: 'unavailable';
  generatedAt: string;
  manifestPath: string;
  reason: string;
};

export type RunManifestCostReport = RunManifestCostOkReport | RunManifestCostUnavailableReport;

type CliArgs = { manifestPath: string; format: Format };

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intOrZero(value: unknown): number {
  const n = numberOrNull(value);
  return n == null ? 0 : Math.trunc(n);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function defaultQueryRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRows } = await import('../lib/postgres');
  return queryRows<T>(sql, params);
}

export function makeUnavailableReport(
  reason: string,
  now = new Date(),
  manifestPath = '',
): RunManifestCostUnavailableReport {
  return { status: 'unavailable', generatedAt: now.toISOString(), manifestPath, reason };
}

function parseManifest(text: string): { issue: number | null; stages: ManifestStage[] } {
  const parsed = JSON.parse(text) as Manifest;
  if (!Array.isArray(parsed.stages)) throw new Error('manifest stages must be an array');
  return {
    issue: numberOrNull(parsed.issue),
    stages: parsed.stages.map((stage) => asObject(stage) ?? {}),
  };
}

function backendCost(stage: ManifestStage): {
  backendCostUsd: number | null;
  backendCostSource: string | null;
  legacyBackendCostUsd: number | null;
} {
  const legacyBackendCostUsd = numberOrNull(stage.cost_usd);
  if ('backend_cost_usd' in stage || 'backend_cost_source' in stage) {
    return {
      backendCostUsd: numberOrNull(stage.backend_cost_usd),
      backendCostSource: stringOrNull(stage.backend_cost_source),
      legacyBackendCostUsd,
    };
  }
  if (legacyBackendCostUsd != null) {
    return {
      backendCostUsd: legacyBackendCostUsd,
      backendCostSource: 'legacy_backend_cost_usd',
      legacyBackendCostUsd,
    };
  }
  return { backendCostUsd: null, backendCostSource: null, legacyBackendCostUsd: null };
}

function delta(backendCostUsd: number | null, dbCostUsd: number | null): number | null {
  return backendCostUsd == null || dbCostUsd == null ? null : backendCostUsd - dbCostUsd;
}

function ratio(backendCostUsd: number | null, dbCostUsd: number | null): number | null {
  if (backendCostUsd == null || dbCostUsd == null || dbCostUsd === 0) return null;
  return backendCostUsd / dbCostUsd;
}

async function fetchDbCostMaps(sessionIds: string[], queryRows: QueryRows): Promise<{
  sessions: Map<string, number | null>;
  linkedChildren: Map<string, { cost: number | null; count: number }>;
  launcherMeta: Map<string, { cost: number | null; count: number }>;
}> {
  if (sessionIds.length === 0) {
    return { sessions: new Map(), linkedChildren: new Map(), launcherMeta: new Map() };
  }

  const [sessionRows, childRows, launcherRows] = await Promise.all([
    queryRows<SessionCostRow>(
      `SELECT id, cost_usd
         FROM sessions
        WHERE id = ANY($1::text[])`,
      [sessionIds],
    ),
    queryRows<ChildCostRow>(
      `SELECT parent_session_id AS session_id,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
              COUNT(*)::int AS child_count
         FROM sessions
        WHERE parent_session_id = ANY($1::text[])
        GROUP BY parent_session_id`,
      [sessionIds],
    ),
    queryRows<LauncherCostRow>(
      `SELECT session_id,
              COALESCE(SUM(
                CASE
                  WHEN meta->>'costUsd' ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
                  THEN (meta->>'costUsd')::float8
                  ELSE NULL
                END
              ), 0)::float8 AS cost_usd,
              COUNT(*) FILTER (WHERE meta ? 'costUsd')::int AS launcher_count
         FROM transcript_events
        WHERE session_id = ANY($1::text[])
          AND meta ? 'costUsd'
        GROUP BY session_id`,
      [sessionIds],
    ),
  ]);

  return {
    sessions: new Map(sessionRows.map((row) => [row.id, numberOrNull(row.cost_usd)])),
    linkedChildren: new Map(
      childRows.map((row) => [row.session_id, { cost: numberOrNull(row.cost_usd), count: intOrZero(row.child_count) }]),
    ),
    launcherMeta: new Map(
      launcherRows.map((row) => [row.session_id, { cost: numberOrNull(row.cost_usd), count: intOrZero(row.launcher_count) }]),
    ),
  };
}

export async function buildRunManifestCostReport({
  manifestPath,
  deps = {},
}: { manifestPath: string; deps?: Deps }): Promise<RunManifestCostReport> {
  const now = deps.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  try {
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const queryRows = deps.queryRows ?? defaultQueryRows;
    const { issue, stages } = parseManifest(readFile(manifestPath));
    const sessionIds = unique(stages.map((stage) => stringOrNull(stage.session_id)).filter((id): id is string => id !== null));
    const db = await fetchDbCostMaps(sessionIds, queryRows);

    return {
      status: 'ok',
      generatedAt,
      manifestPath,
      issue,
      stages: stages.map((stage): StageCostReport => {
        const sessionId = stringOrNull(stage.session_id);
        const dbHasSession = sessionId != null && db.sessions.has(sessionId);
        const dbCostUsd = sessionId == null ? null : db.sessions.get(sessionId) ?? null;
        const { backendCostUsd, backendCostSource, legacyBackendCostUsd } = backendCost(stage);
        const linkedChildren = sessionId == null ? null : db.linkedChildren.get(sessionId) ?? null;
        const launcherMeta = sessionId == null ? null : db.launcherMeta.get(sessionId) ?? null;

        return {
          stage: stringOrNull(stage.stage) ?? '(unknown)',
          session_id: sessionId,
          verdict: stringOrNull(stage.verdict),
          backend: stringOrNull(stage.backend),
          db_status: sessionId == null ? 'no_session_id' : dbHasSession ? 'ok' : 'missing',
          stage_session_cost_usd: dbCostUsd,
          stage_session_cost_source: dbHasSession ? 'db.sessions.cost_usd' : null,
          backend_cost_usd: backendCostUsd,
          backend_cost_source: backendCostSource,
          legacy_backend_cost_usd: legacyBackendCostUsd,
          linked_child_sessions_cost_usd: linkedChildren?.cost ?? null,
          linked_child_sessions_count: linkedChildren?.count ?? 0,
          launcher_meta_subagent_cost_usd: launcherMeta?.cost ?? null,
          launcher_meta_subagent_count: launcherMeta?.count ?? 0,
          delta_backend_vs_db_session_usd: delta(backendCostUsd, dbCostUsd),
          ratio_backend_vs_db_session: ratio(backendCostUsd, dbCostUsd),
        };
      }),
    };
  } catch (error) {
    return makeUnavailableReport(error instanceof Error ? error.message : String(error), new Date(generatedAt), manifestPath);
  }
}

function formatUsd(value: number | null): string {
  if (value == null) return 'null';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(6)}`;
}

function formatNullable(value: number | null): string {
  return value == null ? 'null' : value.toFixed(6);
}

export function formatMarkdown(report: RunManifestCostReport): string {
  if (report.status === 'unavailable') {
    return [
      '# Run Manifest Cost Report',
      '',
      'status: unavailable',
      `cost report unavailable: ${report.reason}`,
      `generatedAt: ${report.generatedAt}`,
      `manifest: ${report.manifestPath || '(none)'}`,
    ].join('\n');
  }

  const lines = [
    '# Run Manifest Cost Report',
    '',
    `status: ${report.status}`,
    `generatedAt: ${report.generatedAt}`,
    `manifest: ${report.manifestPath}`,
    `issue: ${report.issue == null ? 'null' : `#${report.issue}`}`,
    '',
    '## Stages',
  ];

  if (report.stages.length === 0) {
    lines.push('', '- none');
    return lines.join('\n');
  }

  for (const stage of report.stages) {
    lines.push(
      '',
      `- stage=${stage.stage} session_id=${stage.session_id ?? 'null'} verdict=${stage.verdict ?? 'null'} backend=${stage.backend ?? 'null'} db_status=${stage.db_status}`,
      `  stage_session_cost_usd=${formatUsd(stage.stage_session_cost_usd)} stage_session_cost_source=${stage.stage_session_cost_source ?? 'null'}`,
      `  backend_cost_usd=${formatUsd(stage.backend_cost_usd)} backend_cost_source=${stage.backend_cost_source ?? 'null'} legacy_backend_cost_usd=${formatUsd(stage.legacy_backend_cost_usd)}`,
      `  linked_child_sessions_cost_usd=${formatUsd(stage.linked_child_sessions_cost_usd)} linked_child_sessions_count=${stage.linked_child_sessions_count}`,
      `  launcher_meta_subagent_cost_usd=${formatUsd(stage.launcher_meta_subagent_cost_usd)} launcher_meta_subagent_count=${stage.launcher_meta_subagent_count}`,
      `  delta_backend_vs_db_session_usd=${formatUsd(stage.delta_backend_vs_db_session_usd)} ratio_backend_vs_db_session=${formatNullable(stage.ratio_backend_vs_db_session)}`,
    );
  }

  return lines.join('\n');
}

export function formatJson(report: RunManifestCostReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatReport(report: RunManifestCostReport, format: Format): string {
  return format === 'json' ? formatJson(report) : `${formatMarkdown(report)}\n`;
}

function parseFormat(raw: string | undefined): Format {
  if (raw === 'json' || raw === 'markdown') return raw;
  throw new Error('--format must be json or markdown');
}

export function parseArgs(argv: string[]): CliArgs {
  let manifestPath: string | null = null;
  let format: Format = 'markdown';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') {
      manifestPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--manifest=')) {
      manifestPath = arg.slice('--manifest='.length);
    } else if (arg === '--format') {
      format = parseFormat(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--format=')) {
      format = parseFormat(arg.slice('--format='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!manifestPath) throw new Error('--manifest is required');
  return { manifestPath, format };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`run-manifest-cost-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('usage: pnpm -C apps/web exec tsx scripts/run-manifest-cost-report.ts --manifest <path> [--format markdown|json]\n');
    return 2;
  }

  try {
    const report = await buildRunManifestCostReport({ manifestPath: args.manifestPath });
    process.stdout.write(formatReport(report, args.format));
  } finally {
    try {
      const { closePool } = await import('../lib/postgres');
      await closePool().catch(() => undefined);
    } catch {
      // The report may be unavailable before pg is loaded; pool cleanup is best-effort.
    }
  }
  return 0;
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stdout.write(formatReport(makeUnavailableReport(error instanceof Error ? error.message : String(error)), 'markdown'));
      process.exitCode = 0;
    });
}
