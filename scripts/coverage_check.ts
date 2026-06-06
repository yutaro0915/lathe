/*
 * Lathe coverage harness — machine-compares the source of truth (raw Claude Code
 * JSONL transcripts) against the ingested DB (data/lathe.db). Proves there are no
 * silent omissions: every non-empty transcript becomes a session, and every
 * session holds at least as many events as the transcript contains (per the
 * ingester's counting rules), plus every Edit/Write produced a diff hunk.
 *
 * Run:  pnpm coverage    (exits non-zero / prints RED if any gap is found)
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DIR =
  process.argv[2] ||
  process.env.LATHE_TRANSCRIPTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects', '-Users-cherie-LLMWiki');
const DB_PATH = path.join(process.cwd(), 'data', 'lathe.db');

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

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[coverage] DB not found at ${DB_PATH}. Run \`pnpm ingest\` first.`);
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH);

  // DB side, keyed by session id.
  const dbEvents = new Map<string, number>();
  const dbTrunc = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT session_id AS id,
              COUNT(*) AS n,
              SUM(CASE WHEN meta LIKE '%truncated%' THEN 1 ELSE 0 END) AS trunc
         FROM transcript_events GROUP BY session_id`,
    )
    .all() as unknown as { id: string; n: number; trunc: number }[]) {
    dbEvents.set(r.id, r.n);
    dbTrunc.set(r.id, r.trunc);
  }
  const dbHunksTotal = (db.prepare('SELECT COUNT(*) AS n FROM diff_hunks').get() as any).n as number;

  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(DIR, f));

  let ingested = 0,
    empty = 0,
    missing = 0,
    dropped = 0,
    capped = 0,
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
  process.exit(green ? 0 : 1);
}

main();
