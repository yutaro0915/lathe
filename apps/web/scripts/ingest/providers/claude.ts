import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Built } from '../built';
import { resolveProjectIdentity } from '../project';
import { parseJsonlRecords, type LooseRecord } from '../shared';
import {
  parseClaudeSessionRecords,
  type ClaudeSubagentTranscript,
} from './claude-parse';
import type { ProviderBuildOptions, TranscriptProvider } from './types';

export { parseClaudeSessionRecords } from './claude-parse';

function readClaudeSubagents(file: string): ClaudeSubagentTranscript[] {
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (!fs.existsSync(subDir)) return [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }

  const out: ClaudeSubagentTranscript[] = [];
  for (const name of entries) {
    try {
      const jsonlPath = path.join(subDir, name);
      const metaPath = path.join(subDir, name.replace(/\.jsonl$/, '.meta.json'));
      let metaRaw: string | null = null;
      try {
        metaRaw = fs.readFileSync(metaPath, 'utf8');
      } catch {
        metaRaw = null;
      }
      out.push({ name, rawJsonl: fs.readFileSync(jsonlPath, 'utf8'), metaRaw });
    } catch {
      /* skip unreadable subagent transcript */
    }
  }
  return out;
}

function claudeProjectForRecords(recs: LooseRecord[]) {
  const cwd = recs.find((r) => r.cwd)?.cwd || '';
  return resolveProjectIdentity(cwd, cwd ? path.basename(cwd) : 'LLMWiki');
}

export function buildClaudeSession(file: string, opts: ProviderBuildOptions): Built | null {
  const raw = fs.readFileSync(file, 'utf8');
  const recs = parseJsonlRecords(raw);
  if (!recs.length) return null;
  return parseClaudeSessionRecords(
    recs,
    file,
    opts,
    claudeProjectForRecords(recs),
    readClaudeSubagents(file),
  );
}

export class ClaudeProvider implements TranscriptProvider {
  readonly name = 'claude-code' as const;

  constructor(
    private readonly transcriptsDir: string,
    private readonly maxSessions: number,
    private readonly opts: ProviderBuildOptions,
  ) {}

  discover(): string[] {
    return fs
      .readdirSync(this.transcriptsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(this.transcriptsDir, f))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, this.maxSessions)
      .map((x) => x.p);
  }

  build(file: string): Built | null {
    return buildClaudeSession(file, this.opts);
  }
}
