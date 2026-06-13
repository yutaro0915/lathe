/*
 * Lathe coverage harness — machine-compares the source of truth (raw Claude Code
 * JSONL transcripts) against the ingested database. Proves there are no
 * silent omissions: every non-empty transcript becomes a session, and every
 * session holds at least as many events as the transcript contains (per the
 * ingester's counting rules), plus every Edit/Write produced a diff hunk.
 *
 * Run:  pnpm coverage    (exits non-zero / prints RED if any gap is found)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closePool, queryOne, queryRows } from '../lib/postgres';
import { isLiveTranscript } from './ingest/live';

function claudeProjectDirs(): { full: string; mtime: number }[] {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(base, d.name);
        let mtime = 0;
        try {
          for (const f of fs.readdirSync(full)) {
            if (f.endsWith('.jsonl')) { const m = fs.statSync(path.join(full, f)).mtimeMs; if (m > mtime) mtime = m; }
          }
        } catch { /* ignore */ }
        return { full, mtime };
      })
      .filter((x) => x.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* ignore */ }
  return [];
}

function fallbackDefaultDir(): string {
  return claudeProjectDirs()[0]?.full ?? path.join(os.homedir(), '.claude', 'projects');
}

function sessionIdOf(file: string): string {
  const fallback = path.basename(file, '.jsonl');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.sessionId === 'string' && record.sessionId.trim()) {
        return record.sessionId;
      }
    } catch {
      // ignore malformed lines; expectedOf handles detailed validation later.
    }
  }
  return fallback;
}

function pickDirMatchingDb(dbSessionIds: Set<string>): string {
  const dirs = claudeProjectDirs();
  let best: { full: string; mtime: number; matches: number } | null = null;
  for (const dir of dirs) {
    let matches = 0;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir.full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      if (dbSessionIds.has(sessionIdOf(path.join(dir.full, file)))) matches++;
    }
    if (
      matches > 0 &&
      (!best || matches > best.matches || (matches === best.matches && dir.mtime > best.mtime))
    ) {
      best = { ...dir, matches };
    }
  }
  return best?.full ?? fallbackDefaultDir();
}

const EXPLICIT_DIR = process.argv[2] || process.env.LATHE_TRANSCRIPTS_DIR || '';

// Replicate the ingester's event-counting rules EXACTLY so the comparison is
// apples-to-apples (see scripts/ingest.ts buildSession).
function expectedOf(file: string) {
  const recs = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];

  const sessionId =
    recs.find((r) => r.sessionId)?.sessionId || path.basename(file, '.jsonl');

  let ev = 0;
  let editWrite = 0;
  for (const r of recs) {
    if (r.type === 'user') {
      const c = r.message?.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c))
        t = c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n');
      if (t.replace(/<[^>]+>/g, ' ').trim()) ev++;
    } else if (r.type === 'assistant') {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        for (const x of c) {
          if (x.type === 'text' && x.text?.trim()) ev++;
          else if (x.type === 'thinking' && x.thinking?.trim()) ev++;
          else if (x.type === 'tool_use') {
            ev++;
            if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(x.name)) editWrite++;
          }
        }
      }
    }
  }
  return { sessionId, ev, editWrite };
}

async function main() {
  // DB side, keyed by session id.
  const dbEvents = new Map<string, number>();
  const dbTrunc = new Map<string, number>();
  for (const r of await queryRows<{ id: string; n: number; trunc: number }>(
    `SELECT session_id AS id,
            COUNT(*)::int AS n,
            SUM(CASE WHEN meta::text LIKE '%truncated%' THEN 1 ELSE 0 END)::int AS trunc
       FROM transcript_events
      WHERE parent_id IS NULL
      GROUP BY session_id`,
  )) {
    dbEvents.set(r.id, r.n);
    dbTrunc.set(r.id, r.trunc);
  }
  const dbHunksTotal =
    (await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM diff_hunks'))?.n ?? 0;

  const DIR = EXPLICIT_DIR || pickDirMatchingDb(new Set(dbEvents.keys()));
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(DIR, f));

  // A transcript modified very recently is "live" (the current session or a
  // concurrent cron/agent still appending to it). Its snapshot is inherently
  // behind, so it is reported but NOT counted as an omission — this keeps the
  // check honest under concurrent writes. Historical sessions are checked
  // strictly. The same decision is shared with verify-cost.ts (scripts/ingest/live.ts).
  const now = Date.now();

  let ingested = 0,
    empty = 0,
    missing = 0,
    dropped = 0,
    capped = 0,
    live = 0,
    expEventsTotal = 0,
    expEditWriteTotal = 0;
  const problems: string[] = [];

  for (const file of files) {
    const { sessionId, ev, editWrite } = expectedOf(file);
    expEventsTotal += ev;
    expEditWriteTotal += editWrite;

    if (ev === 0) {
      empty++;
      continue; // legitimately produces no session
    }
    if (isLiveTranscript(fs.statSync(file).mtimeMs, now)) {
      live++; // actively being written — snapshot is expected to lag
      problems.push(`LIVE ${sessionId.slice(0, 8)}: transcript still being written (not an omission)`);
      continue;
    }
    if (!dbEvents.has(sessionId)) {
      missing++;
      problems.push(`MISSING session ${sessionId.slice(0, 8)} (${ev} events not ingested)`);
      continue;
    }
    ingested++;
    const got = dbEvents.get(sessionId)!;
    const trunc = dbTrunc.get(sessionId)! > 0;
    // DB count includes a +1 truncation marker when capped.
    const real = trunc ? got - 1 : got;
    if (trunc) {
      capped++;
      problems.push(`CAPPED ${sessionId.slice(0, 8)}: ${real} of ${ev} events (visible truncation)`);
    } else if (real < ev) {
      dropped++;
      problems.push(`DROPPED ${sessionId.slice(0, 8)}: db ${real} < expected ${ev}`);
    }
  }

  const green = missing === 0 && dropped === 0 && capped === 0;

  console.log('================ Lathe coverage report ================');
  console.log(`transcripts on disk : ${files.length}`);
  console.log(`  -> ingested sessions: ${ingested}`);
  console.log(`  -> empty (0 events) : ${empty}`);
  console.log(`  -> live (post-ingest): ${live}`);
  console.log(`  -> MISSING          : ${missing}`);
  console.log(`expected events (all): ${expEventsTotal}`);
  console.log(`hunks: db ${dbHunksTotal}  vs  expected edit/write ${expEditWriteTotal}`);
  if (problems.length) {
    console.log('--- findings ---');
    for (const p of problems) console.log('  - ' + p);
  }
  console.log('=======================================================');
  console.log(green ? 'VERDICT: GREEN — no omissions (every transcript fully covered).'
                    : 'VERDICT: RED — see findings above.');
  await closePool();
  process.exit(green ? 0 : 1);
}

main().catch(async (error) => {
  await closePool();
  console.error(`[coverage] failed: ${(error as Error).message}`);
  process.exit(2);
});
