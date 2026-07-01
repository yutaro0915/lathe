/**
 * Enumerate all ingestable transcript directories under ~/.claude/projects/.
 *
 * Unlike `pickDefaultTranscriptsDir` (shared.ts) which returns a single
 * best-match dir, this function returns ALL qualifying dirs sorted by most
 * recently active first. The caller decides how many / which to process.
 *
 * Exclusions (same logic as pickDefaultTranscriptsDir in shared.ts):
 *  - dirs whose basename contains 'lathe-internal'
 *  - dirs with no ingestable transcript file (no .jsonl with a real event)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TranscriptDir {
  /** Absolute path to the transcript directory. */
  dir: string;
  /** mtime of the most recently modified .jsonl file in the dir. */
  latestMtimeMs: number;
  /** mtime of the most recently modified *ingestable* .jsonl file. */
  latestIngestableMtimeMs: number;
}

// ---------------------------------------------------------------------------
// Ingestability probe (mirrors shared.ts hasIngestableClaudeEvent, not exported there)
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

function hasIngestableEvent(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (rec.type === 'user') {
          const msg = rec.message as Record<string, unknown> | undefined;
          if (textFromContent(msg?.content).replace(/<[^>]+>/g, ' ').trim()) return true;
        } else if (rec.type === 'assistant') {
          const msg = rec.message as Record<string, unknown> | undefined;
          if (Array.isArray(msg?.content)) {
            for (const item of msg!.content as Array<Record<string, unknown>>) {
              if (item?.type === 'text' && typeof item.text === 'string' && (item.text as string).trim()) return true;
              if (item?.type === 'thinking' && typeof item.thinking === 'string' && (item.thinking as string).trim()) return true;
              if (item?.type === 'tool_use') return true;
            }
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Return true when a directory basename should be excluded from ingest.
 *
 * Note: 'lathe-internal' dirs are NO LONGER excluded (ADR 0012 §4 mark-don't-delete).
 * They are ingested and classifySession assigns them session_class='internal'.
 */
export function isExcludedDirName(_name: string): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all transcript directories under `base` that contain at least one
 * ingestable .jsonl file, sorted by most recently active first.
 *
 * @param base  Root directory to scan. Defaults to `~/.claude/projects`.
 */
export function discoverTranscriptDirs(
  base: string = path.join(os.homedir(), '.claude', 'projects'),
): TranscriptDir[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: TranscriptDir[] = [];

  for (const d of entries) {
    if (!d.isDirectory()) continue;
    // Mirror shared.ts exclusion
    if (isExcludedDirName(d.name)) continue;

    const dirPath = path.join(base, d.name);
    let latestMtimeMs = 0;
    let latestIngestableMtimeMs = 0;

    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > latestMtimeMs) latestMtimeMs = mtime;
      if (hasIngestableEvent(filePath) && mtime > latestIngestableMtimeMs) {
        latestIngestableMtimeMs = mtime;
      }
    }

    if (latestIngestableMtimeMs === 0) continue;

    result.push({ dir: dirPath, latestMtimeMs, latestIngestableMtimeMs });
  }

  result.sort((a, b) => b.latestIngestableMtimeMs - a.latestIngestableMtimeMs);
  return result;
}
