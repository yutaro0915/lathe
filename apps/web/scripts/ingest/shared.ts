import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type LooseRecord = Record<string, any>;

function textFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function hasIngestableClaudeEvent(file: string): boolean {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: LooseRecord;
      try {
        record = JSON.parse(line) as LooseRecord;
      } catch {
        continue;
      }
      if (record.type === 'user') {
        if (textFromClaudeContent(record.message?.content).replace(/<[^>]+>/g, ' ').trim()) return true;
      } else if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
        for (const item of record.message.content) {
          if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) return true;
          if (item?.type === 'thinking' && typeof item.thinking === 'string' && item.thinking.trim()) return true;
          if (item?.type === 'tool_use') return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

// Default to the user's most-recently-active Claude project that contains at
// least one transcript the ingester can turn into a session.
export function pickDefaultTranscriptsDir(): string {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    const dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(base, d.name);
        let mtime = 0;
        let ingestableMtime = 0;
        try {
          for (const f of fs.readdirSync(full)) {
            if (f.endsWith('.jsonl')) {
              const file = path.join(full, f);
              const m = fs.statSync(file).mtimeMs;
              if (m > mtime) mtime = m;
              if (hasIngestableClaudeEvent(file) && m > ingestableMtime) ingestableMtime = m;
            }
          }
        } catch { /* ignore */ }
        return { full, mtime, ingestableMtime };
      })
      .filter((x) => x.ingestableMtime > 0)
      .sort((a, b) => b.ingestableMtime - a.ingestableMtime);
    if (dirs.length) return dirs[0].full;
  } catch { /* ignore */ }
  return base;
}

export function repoBasenameOf(transcriptsDir: string): string {
  const segs = path.basename(transcriptsDir).split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : 'project';
}

export function hhmmss(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function lineCount(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

export function clampLines(s: string, prefix: string, max: number): string {
  const lines = (s ?? '').replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, max).map((l) => prefix + l);
  if (lines.length > max) shown.push(`${prefix}… (+${lines.length - max} 行)`);
  return shown.join('\n');
}

export function preview(s: string, n = 90): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

export function durationBetween(aIso?: string, bIso?: string): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

export function parseSubagentUsage(text: string) {
  const t = /subagent_tokens:\s*(\d+)/.exec(text);
  const u = /tool_uses:\s*(\d+)/.exec(text);
  const d = /duration_ms:\s*(\d+)/.exec(text);
  return {
    tokens: t ? Number(t[1]) : null,
    toolUses: u ? Number(u[1]) : null,
    durationMs: d ? Number(d[1]) : null,
  };
}

export function toolType(name: string): string {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file_edit';
    case 'Write':
      return 'file_write';
    case 'Read':
      return 'file_read';
    case 'Bash':
      return 'bash';
    case 'Agent':
    case 'Task':
      return 'subagent';
    case 'Skill':
      return 'skill';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'todo';
    default:
      return 'bash';
  }
}

export function toolTitle(name: string, input: LooseRecord): string {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `File edit · ${input?.file_path ?? ''}`;
    case 'Write':
      return `File write · ${input?.file_path ?? ''}`;
    case 'Read':
      return `File read · ${input?.file_path ?? ''}`;
    case 'Bash':
      return preview(input?.command ?? 'bash', 80);
    case 'Agent':
    case 'Task':
      return `Sub-agent · ${input?.subagent_type ?? input?.description ?? ''}`;
    case 'Skill':
      return `Skill · ${input?.command ?? input?.name ?? ''}`;
    case 'TodoWrite':
      return 'Todo update';
    default:
      return name;
  }
}

export function isCommit(cmd: string): boolean {
  return /\bgit\s+commit\b/.test(cmd || '');
}

export function isTest(cmd: string): boolean {
  return /\b(pytest|jest|vitest|go test|cargo test|npm test|pnpm (run )?test|yarn test|tsc --noEmit)\b/.test(cmd || '');
}
