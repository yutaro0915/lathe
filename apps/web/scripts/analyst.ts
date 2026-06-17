import { closePool } from '../lib/postgres';
import {
  parseTurnSpec,
  runAnalyst,
  runAnalystSmoke,
  type AnalystCandidate,
  type LlmProviderMode,
} from './analyst-engine';

const CANDIDATES: AnalystCandidate[] = ['rules-v1', 'llm-v1', 'hybrid-v1'];
const LLM_PROVIDER_MODES: LlmProviderMode[] = ['auto', 'none', 'claude-acp'];

interface ParsedArgs {
  candidate?: AnalystCandidate;
  sessionId?: string;
  turn?: string;
  limit?: number;
  submit?: boolean;
  llmProviderMode?: LlmProviderMode;
  maxLlmSessions?: number;
  json?: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm -F web analyst -- --candidate <rules-v1|llm-v1|hybrid-v1> [--session <id>] [--turn <session>:<seq>]',
    '  pnpm -F web analyst:smoke',
    '',
    'Options:',
    '  --limit <n>                 Submit at most n findings, capped at 20',
    '  --dry-run                   Generate without submitting',
    '  --llm-provider <mode>       auto | none | claude-acp',
    '  --max-llm-sessions <n>      Limit real sessions bundled into LLM prompts',
    '  --json                      Print machine-readable JSON summary',
  ].join('\n');
}

function readValue(args: string[], index: number, name: string): { value: string; nextIndex: number } {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), nextIndex: index };
  const next = args[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`);
  return { value: next, nextIndex: index + 1 };
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { submit: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--dry-run') {
      parsed.submit = false;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--candidate' || arg.startsWith('--candidate=')) {
      const value = readValue(args, i, '--candidate');
      i = value.nextIndex;
      if (!CANDIDATES.includes(value.value as AnalystCandidate)) {
        throw new Error(`unknown candidate: ${value.value}`);
      }
      parsed.candidate = value.value as AnalystCandidate;
      continue;
    }
    if (arg === '--session' || arg.startsWith('--session=')) {
      const value = readValue(args, i, '--session');
      i = value.nextIndex;
      parsed.sessionId = value.value;
      continue;
    }
    if (arg === '--turn' || arg.startsWith('--turn=')) {
      const value = readValue(args, i, '--turn');
      i = value.nextIndex;
      parsed.turn = value.value;
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const value = readValue(args, i, '--limit');
      i = value.nextIndex;
      parsed.limit = parseNumber(value.value, '--limit');
      continue;
    }
    if (arg === '--llm-provider' || arg.startsWith('--llm-provider=')) {
      const value = readValue(args, i, '--llm-provider');
      i = value.nextIndex;
      if (!LLM_PROVIDER_MODES.includes(value.value as LlmProviderMode)) {
        throw new Error(`unknown --llm-provider: ${value.value}`);
      }
      parsed.llmProviderMode = value.value as LlmProviderMode;
      continue;
    }
    if (arg === '--max-llm-sessions' || arg.startsWith('--max-llm-sessions=')) {
      const value = readValue(args, i, '--max-llm-sessions');
      i = value.nextIndex;
      parsed.maxLlmSessions = parseNumber(value.value, '--max-llm-sessions');
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args[0] === 'smoke') {
    const result = await runAnalystSmoke();
    console.log('candidate\tknown_incident_recall');
    for (const item of result.recall) {
      console.log(`${item.candidate}\t${item.found}/${item.total}${item.skipped ? `\tskip=${item.skipped}` : ''}`);
    }
    console.log(`cleaned_findings\t${result.createdFindingsCleaned}`);
    return;
  }

  const parsed = parseArgs(args);
  if (!parsed.candidate) throw new Error('--candidate is required');
  if (parsed.sessionId && parsed.turn) throw new Error('--session and --turn cannot be used together');

  const result = await runAnalyst({
    candidate: parsed.candidate,
    sessionId: parsed.sessionId,
    turn: parsed.turn ? parseTurnSpec(parsed.turn) : undefined,
    limit: parsed.limit,
    submit: parsed.submit,
    llmProviderMode: parsed.llmProviderMode,
    maxLlmSessions: parsed.maxLlmSessions,
    source: 'cli',
  });

  for (const line of result.logs) console.log(`[analyst] ${line}`);
  if (result.skipped) console.log(`[analyst] skip ${result.candidate}: ${result.skipReason}`);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('candidate\tgenerated\tsubmitted\tcreated\tskipped');
  console.log(`${result.candidate}\t${result.generated}\t${result.submitted}\t${result.created}\t${result.skipped ? 'yes' : 'no'}`);
  for (const item of result.findings) {
    console.log(`${result.candidate}\t${item.findingId ?? '-'}\t${item.kind}\t${item.primarySessionId ?? '-'}\t${item.created === false ? 'existing' : 'created'}\t${item.title}`);
  }
}

main()
  .catch((error) => {
    console.error(`[analyst] ${(error as Error).message}`);
    console.error(usage());
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
