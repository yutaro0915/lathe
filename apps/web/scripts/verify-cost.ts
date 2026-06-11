import * as fs from 'node:fs';
import * as path from 'node:path';
import { costForUsage, resolveTier } from '../lib/cost';
import { closePool, queryRows } from '../lib/postgres';
import { ClaudeProvider } from './ingest/providers/claude';
import { CodexProvider } from './ingest/providers/codex';
import type { ProviderBuildOptions, TranscriptProvider } from './ingest/providers/types';
import { pickDefaultTranscriptsDir, repoBasenameOf } from './ingest/shared';

type Runner = 'claude-code' | 'codex';
type JsonRecord = Record<string, unknown>;

interface SessionRow {
  id: string;
  runner: Runner;
  title: string;
  model: string | null;
  cost_usd: number | null;
  started_at: string;
}

interface Candidate {
  row: SessionRow;
  bucket: 'top' | 'random';
}

interface TranscriptRef {
  file: string;
  runner: Runner;
}

interface RawCost {
  costUsd: number | null;
  model: string | null;
}

const TOLERANCE = 0.005;
const DEFAULT_SEED = 'lathe-verify-cost-v1';
const MAX_SESSIONS = Number(process.env.LATHE_MAX_SESSIONS || 100000);
const BUILD_OPTS: ProviderBuildOptions = {
  maxEvents: Number(process.env.LATHE_MAX_EVENTS || 100000),
  maxFiles: Number(process.env.LATHE_MAX_FILES || 100000),
  maxHunkLines: Number(process.env.LATHE_MAX_HUNK_LINES || 200),
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positionalTranscriptDir(): string | undefined {
  return process.argv.slice(2).find((arg) => !arg.startsWith('-'));
}

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readJsonl(file: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (asRecord(record)) records.push(record as JsonRecord);
    } catch {
      // Match ingest behavior: malformed lines do not make the transcript unusable.
    }
  }
  return records;
}

function inferTranscript(file: string, runner: Runner): TranscriptRef | null {
  for (const record of readJsonl(file)) {
    if (runner === 'codex') {
      if (record.type === 'session_meta') {
        const payload = asRecord(record.payload);
        const id = str(payload?.id);
        if (id) return { file, runner };
      }
      continue;
    }

    const id = str(record.sessionId);
    if (id) return { file, runner };
  }

  if (runner === 'claude-code') return { file, runner };
  return null;
}

function transcriptId(file: string, runner: Runner): string | null {
  for (const record of readJsonl(file)) {
    if (runner === 'codex') {
      if (record.type === 'session_meta') {
        const payload = asRecord(record.payload);
        const id = str(payload?.id);
        if (id) return id;
      }
      continue;
    }

    const id = str(record.sessionId);
    if (id) return id;
  }

  return runner === 'claude-code' ? path.basename(file, '.jsonl') : null;
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededSample<T extends { id: string }>(items: T[], n: number, seed: string): T[] {
  return items
    .map((item) => ({ item, rank: hashSeed(`${seed}:${item.id}`) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, n)
    .map((entry) => entry.item);
}

function usd(value: number | null): string {
  return value == null ? 'null' : `$${value.toFixed(6)}`;
}

function costMatches(dbCost: number | null, rawCost: number | null): boolean {
  if (dbCost == null || rawCost == null) return dbCost == null && rawCost == null;
  if (dbCost === 0 && rawCost === 0) return true;
  const diff = Math.abs(dbCost - rawCost);
  const denom = Math.max(Math.abs(dbCost), Math.abs(rawCost), Number.EPSILON);
  return diff / denom <= TOLERANCE;
}

function relativeDiff(dbCost: number | null, rawCost: number | null): string {
  if (dbCost == null || rawCost == null) return dbCost === rawCost ? '0.000%' : 'n/a';
  if (dbCost === 0 && rawCost === 0) return '0.000%';
  const diff = Math.abs(dbCost - rawCost);
  const denom = Math.max(Math.abs(dbCost), Math.abs(rawCost), Number.EPSILON);
  return `${((diff / denom) * 100).toFixed(4)}%`;
}

function recalcClaudeCost(file: string): RawCost {
  let costUsd = 0;
  let priced = false;
  let firstModel: string | null = null;

  for (const record of readJsonl(file)) {
    if (record.type !== 'assistant') continue;
    const message = asRecord(record.message);
    const usage = asRecord(message?.usage);
    const model = str(message?.model);
    if (!firstModel && model) firstModel = model;
    if (!usage) continue;

    const cost = costForUsage(model, {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
    });
    if (cost != null) {
      costUsd += cost;
      priced = true;
    }
  }

  return { costUsd: priced ? costUsd : null, model: firstModel };
}

function recalcCodexCost(file: string): RawCost {
  const records = readJsonl(file);
  const meta = asRecord(records.find((record) => record.type === 'session_meta')?.payload);
  const turn = asRecord(records.find((record) => record.type === 'turn_context')?.payload);
  const model = str(turn?.model) || str(meta?.model) || 'codex';

  let input = 0;
  let output = 0;
  let cachedInput = 0;
  for (const record of records) {
    if (record.type !== 'event_msg') continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== 'token_count') continue;
    const info = asRecord(payload.info);
    const usage = asRecord(info?.total_token_usage);
    if (!usage) continue;
    input = num(usage.input_tokens);
    output = num(usage.output_tokens);
    cachedInput = num(usage.cached_input_tokens);
  }

  const freshInput = Math.max(0, input - cachedInput);
  return {
    costUsd: costForUsage(model, {
      input: freshInput,
      output,
      cacheWrite: 0,
      cacheRead: cachedInput,
    }),
    model,
  };
}

function recalcCost(ref: TranscriptRef): RawCost {
  if (ref.runner === 'claude-code') return recalcClaudeCost(ref.file);
  return recalcCodexCost(ref.file);
}

function addProviderFiles(index: Map<string, TranscriptRef>, provider: TranscriptProvider): number {
  let count = 0;
  for (const file of provider.discover()) {
    const id = transcriptId(file, provider.name as Runner);
    if (!id) continue;
    const ref = inferTranscript(file, provider.name as Runner);
    if (!ref) continue;
    if (!index.has(id)) index.set(id, ref);
    count++;
  }
  return count;
}

function buildTranscriptIndex(): { index: Map<string, TranscriptRef>; counts: Record<string, number>; transcriptsDir: string } {
  const transcriptsDir =
    argValue('--transcripts-dir') ||
    positionalTranscriptDir() ||
    process.env.LATHE_TRANSCRIPTS_DIR ||
    pickDefaultTranscriptsDir();
  const index = new Map<string, TranscriptRef>();
  const counts: Record<string, number> = {};

  if (fs.existsSync(transcriptsDir)) {
    counts['claude-code'] = addProviderFiles(index, new ClaudeProvider(transcriptsDir, MAX_SESSIONS, BUILD_OPTS));
  } else {
    counts['claude-code'] = 0;
  }

  if (process.env.LATHE_NO_CODEX !== '1') {
    const codexProject = process.env.LATHE_CODEX_PROJECT || repoBasenameOf(transcriptsDir);
    counts.codex = addProviderFiles(index, new CodexProvider(codexProject, MAX_SESSIONS, BUILD_OPTS));
  } else {
    counts.codex = 0;
  }

  return { index, counts, transcriptsDir };
}

function candidateKey(candidate: Candidate): string {
  return candidate.row.id;
}

// Direct rate-resolution assertions (issue #5). The recalculation check below
// reuses resolveTier/costForUsage, so a resolution bug would cancel out there
// (DB and recalc both wrong). These fixtures pin model-id -> rate against the
// first-party prices recorded in docs/cost-semantics.md, so prefix/tier
// matching regressions (e.g. opus-4-8 falling back to the legacy opus tier)
// fail loudly. null rows assert that unpriceable ids stay unpriced.
const RATE_EXPECTATIONS: Array<{ model: string; expect: { input: number; output: number; cacheWrite: number; cacheRead: number } | null }> = [
  { model: 'claude-opus-4-8', expect: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { model: 'claude-opus-4-8-20260301', expect: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { model: 'claude-opus-4-1', expect: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { model: 'claude-fable-5', expect: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { model: 'claude-sonnet-4-6', expect: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { model: 'claude-haiku-4-5-20251001', expect: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { model: 'gpt-5.5', expect: { input: 5, output: 30, cacheWrite: 5, cacheRead: 0.5 } },
  { model: 'gpt-5.5-2026-05-12', expect: { input: 5, output: 30, cacheWrite: 5, cacheRead: 0.5 } },
  { model: 'gpt-5-codex', expect: { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 } },
  { model: 'codex-mini', expect: { input: 1.5, output: 6, cacheWrite: 1.5, cacheRead: 0.375 } },
  { model: 'codex-auto-review', expect: null },
  { model: '<synthetic>', expect: null },
];

function assertRateResolution(): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  for (const { model, expect } of RATE_EXPECTATIONS) {
    const got = resolveTier(model);
    const ok = expect === null
      ? got === null
      : got !== null &&
        got.input === expect.input &&
        got.output === expect.output &&
        got.cacheWrite === expect.cacheWrite &&
        got.cacheRead === expect.cacheRead;
    const show = (r: { input: number; output: number; cacheWrite: number; cacheRead: number } | null) =>
      r ? `${r.input}/${r.output}/${r.cacheWrite}/${r.cacheRead}` : 'null';
    if (ok) {
      lines.push(`${model.padEnd(26)} -> ${show(got)}`);
    } else {
      failures.push(`rate resolution ${model}: expected ${show(expect)} got ${show(got)}`);
    }
  }
  return { lines, failures };
}

async function main(): Promise<void> {
  const seed = argValue('--seed') || process.env.LATHE_VERIFY_COST_SEED || DEFAULT_SEED;
  const top = await queryRows<SessionRow>(
    `SELECT id, runner, title, model, cost_usd, started_at
       FROM sessions
      WHERE cost_usd IS NOT NULL
      ORDER BY cost_usd DESC
      LIMIT 5`,
  );
  const all = await queryRows<SessionRow>(
    `SELECT id, runner, title, model, cost_usd, started_at
       FROM sessions
      ORDER BY id ASC`,
  );
  if (all.length === 0) throw new Error('sessions table is empty; run pnpm -F web ingest first');

  const topIds = new Set(top.map((row) => row.id));
  const randomPool = all.filter((row) => !topIds.has(row.id));
  const random = seededSample(randomPool, Math.min(10, randomPool.length), seed);
  const candidates = new Map<string, Candidate>();
  for (const row of top) candidates.set(row.id, { row, bucket: 'top' });
  for (const row of random) {
    const prior = candidates.get(row.id);
    candidates.set(row.id, { row, bucket: prior ? 'top' : 'random' });
  }

  const { index, counts, transcriptsDir } = buildTranscriptIndex();
  const rates = assertRateResolution();
  const failures: string[] = [...rates.failures];
  const checked: string[] = [];

  for (const candidate of [...candidates.values()].sort((a, b) => candidateKey(a).localeCompare(candidateKey(b)))) {
    const ref = index.get(candidate.row.id);
    if (!ref) {
      failures.push(`${candidate.bucket} ${candidate.row.id}: raw transcript not found`);
      continue;
    }
    if (ref.runner !== candidate.row.runner) {
      failures.push(`${candidate.bucket} ${candidate.row.id}: runner mismatch db=${candidate.row.runner} raw=${ref.runner}`);
      continue;
    }

    const raw = recalcCost(ref);
    if (!costMatches(candidate.row.cost_usd, raw.costUsd)) {
      failures.push(
        `${candidate.bucket} ${candidate.row.id}: db=${usd(candidate.row.cost_usd)} raw=${usd(raw.costUsd)} diff=${relativeDiff(candidate.row.cost_usd, raw.costUsd)} file=${ref.file}`,
      );
      continue;
    }

    checked.push(
      `${candidate.bucket.padEnd(6)} ${candidate.row.id.slice(0, 8)} runner=${candidate.row.runner} model=${raw.model ?? candidate.row.model ?? 'unknown'} db=${usd(candidate.row.cost_usd)} raw=${usd(raw.costUsd)} diff=${relativeDiff(candidate.row.cost_usd, raw.costUsd)}`,
    );
  }

  console.log('================ Lathe cost verification ================');
  console.log(`transcripts dir : ${transcriptsDir}`);
  console.log(`indexed         : claude-code=${counts['claude-code'] ?? 0} codex=${counts.codex ?? 0}`);
  console.log(`sample          : top=${top.length} random=${random.length} checked=${checked.length} seed=${seed}`);
  console.log(`tolerance       : ${(TOLERANCE * 100).toFixed(2)}%`);
  console.log(`rate assertions : ${RATE_EXPECTATIONS.length - rates.failures.length}/${RATE_EXPECTATIONS.length} OK (model-id -> usd/Mtok, pinned to docs/cost-semantics.md)`);
  if (checked.length) {
    console.log('--- checked ---');
    for (const line of checked) console.log(`  - ${line}`);
  }
  if (failures.length) {
    console.log('--- findings ---');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log('==========================================================');
  console.log(
    failures.length === 0
      ? 'VERDICT: GREEN - DB cost matches raw transcript recalculation.'
      : 'VERDICT: RED - cost mismatches or missing transcripts found.',
  );

  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`[verify-cost] failed: ${(error as Error).message}`);
    process.exitCode = 2;
  })
  .finally(async () => {
    await closePool();
  });
