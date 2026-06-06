/*
 * Lathe Phase 1 — real transcript ingester.
 *
 * Reads actual Claude Code session transcripts (JSONL) and populates
 * data/lathe.db with real sessions, events, git diffs, and attributions.
 *
 * Claude Code stores one JSONL file per session under
 *   ~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl
 * Each line is an event: { type, timestamp, uuid, message, toolUseResult, ... }.
 *  - assistant lines: message.content[] of { type: text | thinking | tool_use }
 *  - user lines:      message.content is a string, or [] of { text | tool_result }
 *  - tool_use.input carries the real arguments. Edit has old_string/new_string,
 *    Write has content, Bash has command — so the git diff and its attribution
 *    are reconstructed from the actual tool calls, not mocked.
 *
 * Usage:  pnpm ingest [transcriptsDir]
 *   env: LATHE_TRANSCRIPTS_DIR, LATHE_MAX_SESSIONS (default 12),
 *        LATHE_MAX_EVENTS (per session, default 500)
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TRANSCRIPTS_DIR =
  process.argv[2] ||
  process.env.LATHE_TRANSCRIPTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects', '-Users-cherie-LLMWiki');
// Ingest ALL sessions and ALL events by default (no silent omissions). The caps
// remain as high safety bounds; if ever exceeded, truncation is made VISIBLE in
// the UI (a trailing marker event / "+N 行" on hunks). Override via env.
const MAX_SESSIONS = Number(process.env.LATHE_MAX_SESSIONS || 100000);
const MAX_EVENTS = Number(process.env.LATHE_MAX_EVENTS || 100000);
const MAX_FILES = Number(process.env.LATHE_MAX_FILES || 100000); // changed files per session
const MAX_HUNK_LINES = Number(process.env.LATHE_MAX_HUNK_LINES || 200); // truncate very large hunks (visible)

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, 'data', 'lathe.db');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');

// ----- helpers --------------------------------------------------------------

function hhmmss(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

function clampLines(s: string, prefix: string, max: number): string {
  const lines = (s ?? '').replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, max).map((l) => prefix + l);
  if (lines.length > max) shown.push(`${prefix}… (+${lines.length - max} 行)`);
  return shown.join('\n');
}

function preview(s: string, n = 90): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

// real execution time = gap between a tool_use and its tool_result timestamp
function durationBetween(aIso?: string, bIso?: string): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

// sub-agent result text carries "<usage>subagent_tokens: .. tool_uses: .. duration_ms: ..</usage>"
function parseSubagentUsage(text: string) {
  const t = /subagent_tokens:\s*(\d+)/.exec(text);
  const u = /tool_uses:\s*(\d+)/.exec(text);
  const d = /duration_ms:\s*(\d+)/.exec(text);
  return {
    tokens: t ? Number(t[1]) : null,
    toolUses: u ? Number(u[1]) : null,
    durationMs: d ? Number(d[1]) : null,
  };
}

// tool name -> our event type (kept within the 12 schema types)
function toolType(name: string): string {
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
      return 'bash'; // generic tool call (MCP / Glob / WebFetch / Workflow / …)
  }
}

function toolTitle(name: string, input: any): string {
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
      return name; // show the real tool name
  }
}

function isCommit(cmd: string): boolean {
  return /\bgit\s+commit\b/.test(cmd || '');
}
function isTest(cmd: string): boolean {
  return /\b(pytest|jest|vitest|go test|cargo test|npm test|pnpm (run )?test|yarn test|tsc --noEmit)\b/.test(
    cmd || '',
  );
}

// ----- parse one transcript file -------------------------------------------

// Parse a sub-agent transcript (<session>/subagents/agent-<id>.jsonl) into CHILD
// events linked to the launching Agent event. Captures the sub-agent's messages,
// tools and skills so they can be expanded under the parent in the main view.
function extractChildEvents(
  saFile: string,
  parentEventId: string,
  sessionId: string,
  agentLabel: string,
): any[] {
  let recs: any[];
  try {
    recs = fs
      .readFileSync(saFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }

  const results = new Map<string, { isError: boolean; text: string; ts?: string }>();
  for (const r of recs) {
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_result' && c.tool_use_id) {
          const text =
            typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
                ? c.content.map((x: any) => x?.text ?? '').join('\n')
                : '';
          results.set(c.tool_use_id, { isError: !!c.is_error, text, ts: r.timestamp });
        }
      }
    }
  }

  const out: any[] = [];
  let k = 0;
  const add = (e: any) => {
    k += 1;
    out.push({
      ...e,
      id: `${parentEventId}_c${k}`,
      session_id: sessionId,
      seq: k,
      parent_id: parentEventId,
      subagent: agentLabel,
    });
  };

  for (const r of recs) {
    const ts = hhmmss(r.timestamp);
    if (r.type === 'user') {
      const c = r.message?.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c))
        t = c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n');
      const clean = t.replace(/<[^>]+>/g, ' ').trim();
      if (clean)
        add({ ts, type: 'user_message', actor: 'user', title: preview(clean, 90), body: t.slice(0, 2000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
    } else if (r.type === 'assistant') {
      const c = r.message?.content;
      if (!Array.isArray(c)) continue;
      for (const x of c) {
        if (x.type === 'text' && x.text?.trim()) {
          add({ ts, type: 'assistant_message', actor: 'subagent', title: preview(x.text, 90), body: x.text.slice(0, 2000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
        } else if (x.type === 'tool_use') {
          const name = x.name as string;
          const input = x.input || {};
          const res = x.id ? results.get(x.id) : undefined;
          const exit = res ? (res.isError ? 1 : 0) : null;
          const cmd = name === 'Bash' ? input.command ?? null : null;
          const fp =
            input.file_path ??
            (name === 'Read' || name === 'Write' || name === 'Edit' ? input.path : null) ??
            null;
          let etype = toolType(name);
          if (name === 'Bash' && cmd) {
            if (isCommit(cmd)) etype = 'commit';
            else if (isTest(cmd)) etype = 'test';
          }
          add({ ts, type: etype, actor: 'subagent', title: toolTitle(name, input), body: (res?.text || '').slice(0, 2000) || preview(JSON.stringify(input), 200), file_path: fp, command: cmd, exit_code: exit, duration_ms: durationBetween(r.timestamp, res?.ts), token_usage: null, meta: JSON.stringify({ tool: name }) });
        }
      }
    }
  }
  return out;
}

interface Built {
  session: any;
  events: any[];
  eventFiles: any[];
  changedFiles: any[];
  hunks: any[];
  attributions: any[];
  annotations: any[];
}

function buildSession(file: string): Built | null {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const recs: any[] = [];
  for (const l of lines) {
    try {
      recs.push(JSON.parse(l));
    } catch {
      /* skip malformed line */
    }
  }
  if (!recs.length) return null;

  const sessionId =
    recs.find((r) => r.sessionId)?.sessionId || path.basename(file, '.jsonl');
  const gitBranch = recs.find((r) => r.gitBranch)?.gitBranch || '';
  const cwd = recs.find((r) => r.cwd)?.cwd || '';
  const version = recs.find((r) => r.version)?.version || '';
  const model =
    recs.find((r) => r.type === 'assistant' && r.message?.model)?.message
      ?.model || 'claude-code';
  // title: prefer a custom/ai title line, else first real user text
  const titleRec = [...recs]
    .reverse()
    .find((r) => r.type === 'custom-title' || r.type === 'ai-title');
  let title =
    titleRec?.customTitle || titleRec?.aiTitle || titleRec?.title || '';

  // map tool_use id -> result (exit/error) from tool_result lines + toolUseResult
  const results = new Map<string, { isError: boolean; text: string; ts?: string }>();
  for (const r of recs) {
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_result' && c.tool_use_id) {
          const text =
            typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
                ? c.content.map((x: any) => x?.text ?? '').join('\n')
                : '';
          results.set(c.tool_use_id, { isError: !!c.is_error, text, ts: r.timestamp });
        }
      }
    }
  }

  const events: any[] = [];
  const eventFiles: any[] = [];
  const filesByPath = new Map<string, any>();
  const hunks: any[] = [];
  const attributions: any[] = [];
  const annotations: any[] = [];
  const agentLaunchers = new Map<string, string>(); // tool_use id -> launcher event id

  let seq = 0;
  let truncated = 0;
  let firstTs = '';
  let lastTs = '';
  let tokenUsage = 0;
  let tokenIn = 0;
  let tokenOut = 0;
  const counts: Record<string, number> = {};

  const addEvent = (e: any) => {
    seq += 1;
    e.seq = seq;
    e.session_id = sessionId;
    e.id = `${sessionId}_${seq}`; // globally unique, overrides any provided id
    events.push(e);
    counts[e.type] = (counts[e.type] || 0) + 1;
    return e;
  };

  const ensureFile = (p: string, lang: string | null) => {
    let f = filesByPath.get(p);
    if (!f) {
      f = {
        id: `chf_${sessionId}_${filesByPath.size + 1}`,
        session_id: sessionId,
        path: p,
        status: 'modified',
        additions: 0,
        deletions: 0,
        language: lang,
        seq: filesByPath.size + 1,
        _hunkSeq: 0,
        _firstWrite: false,
      };
      filesByPath.set(p, f);
    }
    return f;
  };

  const langOf = (p: string): string | null => {
    const ext = p.split('.').pop()?.toLowerCase();
    const m: Record<string, string> = {
      ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
      py: 'python', sql: 'sql', css: 'css', md: 'markdown',
      json: 'json', sh: 'bash', mjs: 'javascript', html: 'html',
    };
    return (ext && m[ext]) || null;
  };

  for (const r of recs) {
    if (r.timestamp) {
      if (!firstTs) firstTs = r.timestamp;
      lastTs = r.timestamp;
    }
    const ts = hhmmss(r.timestamp);

    if (r.type === 'user') {
      const content = r.message?.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      }
      // strip slash-command xml wrappers for the headline
      const clean = text.replace(/<[^>]+>/g, ' ').trim();
      if (clean) {
        if (seq >= MAX_EVENTS) { truncated++; continue; }
        addEvent({
          id: r.uuid || `evt_${sessionId.slice(0, 6)}_${seq + 1}`,
          ts, type: 'user_message', actor: 'user',
          title: preview(clean, 90), body: text.slice(0, 4000),
          file_path: null, command: null, exit_code: null,
          duration_ms: null, token_usage: null,
          subagent: r.isSidechain ? 'sidechain' : null, meta: null,
        });
      }
      continue;
    }

    if (r.type === 'assistant') {
      const usage = r.message?.usage;
      if (usage) {
        // count real work: input + output + cache creation.
        // EXCLUDE cache_read (the same cached prefix is re-read every step,
        // which balloons the total without reflecting tokens actually produced).
        const inTok =
          (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        const outTok = usage.output_tokens || 0;
        tokenIn += inTok;
        tokenOut += outTok;
        tokenUsage += inTok + outTok;
      }
      const content = r.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (seq >= MAX_EVENTS) { truncated++; continue; }
        if (c.type === 'text' && c.text?.trim()) {
          addEvent({
            id: (r.uuid || `a_${seq}`) + ':t',
            ts, type: 'assistant_message', actor: 'assistant',
            title: preview(c.text, 90), body: c.text.slice(0, 4000),
            file_path: null, command: null, exit_code: null,
            duration_ms: null,
            token_usage: usage?.output_tokens ?? null,
            subagent: r.isSidechain ? 'sidechain' : null, meta: null,
          });
        } else if (c.type === 'tool_use') {
          const name = c.name as string;
          const input = c.input || {};
          const type = toolType(name);
          const res = c.id ? results.get(c.id) : undefined;
          const exit = res ? (res.isError ? 1 : 0) : null;
          const cmd = name === 'Bash' ? input.command ?? null : null;
          const fp =
            input.file_path ??
            (name === 'Read' || name === 'Write' || name === 'Edit'
              ? input.path
              : null) ??
            null;
          // refine bash -> commit/test
          let etype = type;
          if (name === 'Bash' && cmd) {
            if (isCommit(cmd)) etype = 'commit';
            else if (isTest(cmd)) etype = 'test';
          }
          // real duration = time from this tool_use to its result
          let durMs = durationBetween(r.timestamp, res?.ts);
          let tok: number | null = null;
          const metaObj: any = { tool: name };
          if (name === 'Agent' || name === 'Task') {
            const u = parseSubagentUsage(res?.text || '');
            if (u.durationMs != null) durMs = u.durationMs; // explicit, more accurate
            if (u.tokens != null) tok = u.tokens;
            if (u.toolUses != null) metaObj.toolUses = u.toolUses;
          }
          const ev = addEvent({
            id: c.id || `tu_${seq}`,
            ts, type: etype, actor: r.isSidechain ? 'subagent' : 'assistant',
            title: toolTitle(name, input),
            body: (res?.text || '').slice(0, 3000) || preview(JSON.stringify(input), 300),
            file_path: fp, command: cmd, exit_code: exit,
            duration_ms: durMs, token_usage: tok,
            subagent: name === 'Agent' || name === 'Task'
              ? input.subagent_type || input.description || 'sub-agent'
              : r.isSidechain ? 'sidechain' : null,
            meta: JSON.stringify(metaObj),
          });
          if ((name === 'Agent' || name === 'Task') && c.id) {
            agentLaunchers.set(c.id, ev.id);
          }

          // event_files + annotations
          if (fp && (etype === 'file_edit' || etype === 'file_write' || etype === 'file_read')) {
            eventFiles.push({
              event_id: ev.id, path: fp,
              role: etype === 'file_read' ? 'read' : etype === 'file_write' ? 'write' : 'edit',
            });
          }
          if (exit === 1) annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'error', note: preview(ev.title, 60) });
          else if (etype === 'commit') annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'commit', note: preview(cmd || '', 60) });
          else if (etype === 'test') annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'test', note: preview(cmd || '', 60) });

          // ----- reconstruct the real diff + attribution -----
          if ((name === 'Write' || name === 'Edit' || name === 'MultiEdit') && fp && filesByPath.size < MAX_FILES) {
            const f = ensureFile(fp, langOf(fp));
            if (name === 'Write') {
              const adds = lineCount(input.content || '');
              if (!filesByPath.has(fp) || !f._firstWrite) { f.status = f.additions === 0 ? 'added' : 'modified'; f._firstWrite = true; }
              f.additions += adds;
              f._hunkSeq += 1;
              const hid = `${f.id}_h${f._hunkSeq}`;
              hunks.push({
                id: hid, file_id: f.id, seq: f._hunkSeq,
                header: `@@ Write ${fp} (+${adds}) @@`,
                content: clampLines(input.content || '', '+', MAX_HUNK_LINES),
              });
              attributions.push({
                id: `att_${hid}`, hunk_id: hid, event_id: ev.id,
                confidence: 'high', method: 'edit_event',
                note: 'Write ツールが直接生成',
              });
            } else {
              const edits = name === 'MultiEdit' && Array.isArray(input.edits)
                ? input.edits
                : [{ old_string: input.old_string, new_string: input.new_string }];
              for (const ed of edits) {
                const del = lineCount(ed.old_string || '');
                const add = lineCount(ed.new_string || '');
                f.additions += add;
                f.deletions += del;
                f._hunkSeq += 1;
                const hid = `${f.id}_h${f._hunkSeq}`;
                const body =
                  clampLines(ed.old_string || '', '-', MAX_HUNK_LINES / 2) +
                  '\n' +
                  clampLines(ed.new_string || '', '+', MAX_HUNK_LINES / 2);
                hunks.push({
                  id: hid, file_id: f.id, seq: f._hunkSeq,
                  header: `@@ Edit ${fp} (-${del} +${add}) @@`,
                  content: body,
                });
                attributions.push({
                  id: `att_${hid}`, hunk_id: hid, event_id: ev.id,
                  confidence: 'high', method: 'edit_event',
                  note: 'Edit ツールの old_string→new_string',
                });
              }
            }
          }
        }
      }
      continue;
    }
    // other line types (system / attachment / titles / queue) -> metadata only
  }

  // ---- sub-agent transcripts: <session>/subagents/agent-<id>.jsonl ----------
  // Each Agent/Task launch writes its own transcript; meta.json.toolUseId links
  // it back to the launching tool_use. Ingest those as child events so the
  // sub-agent's tools/skills can be expanded under the parent in the main view.
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) {
    let saFiles: string[] = [];
    try {
      saFiles = fs.readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f));
    } catch {
      saFiles = [];
    }
    for (const saName of saFiles) {
      const metaPath = path.join(subDir, saName.replace(/\.jsonl$/, '.meta.json'));
      let toolUseId: string | null = null;
      let agentType = 'sub-agent';
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        toolUseId = m.toolUseId || null;
        agentType = m.agentType || agentType;
      } catch {
        /* no meta — skip */
      }
      if (!toolUseId) continue;
      const parentEventId = agentLaunchers.get(toolUseId);
      if (!parentEventId) continue; // launcher not in this session (shouldn't happen)
      const children = extractChildEvents(path.join(subDir, saName), parentEventId, sessionId, agentType);
      for (const ce of children) events.push(ce);
    }
  }

  if (truncated) {
    addEvent({
      id: `trunc_${sessionId.slice(0, 8)}`, ts: lastTs ? hhmmss(lastTs) : '',
      type: 'todo', actor: 'system',
      title: `(表示上限 ${MAX_EVENTS} 件で打ち切り — 残り ${truncated} 件)`,
      body: null, file_path: null, command: null, exit_code: null,
      duration_ms: null, token_usage: null, subagent: null,
      meta: JSON.stringify({ truncated }),
    });
  }

  if (!title) {
    const firstUser = events.find((e) => e.type === 'user_message');
    title = firstUser ? preview(firstUser.title, 70) : '(untitled session)';
  }

  const durationMs =
    firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : null;
  const status = annotations.some((a) => a.kind === 'error') ? 'failed' : 'done';

  const session = {
    id: sessionId,
    project: cwd ? path.basename(cwd) : 'LLMWiki',
    title,
    runner: 'claude-code',
    model,
    status,
    started_at: firstTs ? firstTs.replace('T', ' ').slice(0, 19) : '',
    ended_at: lastTs ? lastTs.replace('T', ' ').slice(0, 19) : null,
    duration_ms: durationMs,
    turn_count: counts['user_message'] || 0,
    tool_count: events.filter((e) => e.command !== null || (e.meta && e.meta.includes('tool'))).length,
    edit_count: (counts['file_edit'] || 0) + (counts['file_write'] || 0),
    bash_count: counts['bash'] || 0,
    subagent_count: counts['subagent'] || 0,
    token_usage: tokenUsage,
    token_in: tokenIn,
    token_out: tokenOut,
    git_branch: gitBranch || null,
    commit_count: counts['commit'] || 0,
    cost_usd: null, // not derivable from the transcript — left null rather than faked
    summary: `${gitBranch ? gitBranch + ' · ' : ''}${version ? 'cc ' + version : ''}`.trim() || null,
    seq: 0,
    _startMs: firstTs ? new Date(firstTs).getTime() : 0,
  };

  // finalize changed file list (cap)
  const changedFiles = [...filesByPath.values()].slice(0, MAX_FILES).map((f) => {
    delete f._hunkSeq; delete f._firstWrite; return f;
  });

  return { session, events, eventFiles, changedFiles, hunks, attributions, annotations };
}

// ----- main -----------------------------------------------------------------

function main() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.error(`[ingest] transcripts dir not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(TRANSCRIPTS_DIR, f))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS)
    .map((x) => x.p);

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  const built: Built[] = [];
  for (const f of files) {
    try {
      const b = buildSession(f);
      if (b && b.events.length) built.push(b);
    } catch (e) {
      console.error(`[ingest] failed on ${path.basename(f)}: ${(e as Error).message}`);
    }
  }

  // order sessions newest-first; seq 1 = primary (most recent)
  built.sort((a, b) => b.session._startMs - a.session._startMs);
  built.forEach((b, i) => (b.session.seq = i + 1));

  const insSession = db.prepare(
    `INSERT INTO sessions (id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insEvent = db.prepare(
    `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insFile = db.prepare(
    `INSERT INTO changed_files (id,session_id,path,status,additions,deletions,language,seq) VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insHunk = db.prepare(
    `INSERT INTO diff_hunks (id,file_id,seq,header,content) VALUES (?,?,?,?,?)`,
  );
  const insAttr = db.prepare(
    `INSERT INTO attributions (id,hunk_id,event_id,confidence,method,note) VALUES (?,?,?,?,?,?)`,
  );
  const insEvFile = db.prepare(
    `INSERT INTO event_files (event_id,path,role) VALUES (?,?,?)`,
  );
  const insAnn = db.prepare(
    `INSERT INTO annotations (session_id,at_seq,kind,note) VALUES (?,?,?,?)`,
  );

  const validEventIds = new Set<string>();
  for (const b of built) for (const e of b.events) validEventIds.add(e.id);

  let nEvents = 0, nFiles = 0, nHunks = 0, nAttr = 0, nEvFiles = 0, nAnn = 0;
  db.exec('BEGIN');
  for (const b of built) {
    const s = b.session;
    insSession.run(s.id, s.project, s.title, s.runner, s.model, s.status, s.started_at, s.ended_at, s.duration_ms, s.turn_count, s.tool_count, s.edit_count, s.bash_count, s.subagent_count, s.token_usage, s.token_in, s.token_out, s.git_branch, s.commit_count, s.cost_usd, s.summary, s.seq);
    for (const e of b.events) {
      insEvent.run(e.id, e.session_id, e.seq, e.ts, e.type, e.actor, e.title, e.body, e.file_path, e.command, e.exit_code, e.duration_ms, e.token_usage, e.subagent, e.meta, e.parent_id ?? null);
      nEvents++;
    }
    for (const f of b.changedFiles) { insFile.run(f.id, f.session_id, f.path, f.status, f.additions, f.deletions, f.language, f.seq); nFiles++; }
    for (const h of b.hunks) { insHunk.run(h.id, h.file_id, h.seq, h.header, h.content); nHunks++; }
    for (const a of b.attributions) {
      const eid = a.event_id && validEventIds.has(a.event_id) ? a.event_id : null;
      insAttr.run(a.id, a.hunk_id, eid, a.confidence, a.method, a.note); nAttr++;
    }
    for (const ef of b.eventFiles) {
      if (validEventIds.has(ef.event_id)) { insEvFile.run(ef.event_id, ef.path, ef.role); nEvFiles++; }
    }
    for (const an of b.annotations) { insAnn.run(an.session_id, an.at_seq, an.kind, an.note); nAnn++; }
  }
  db.exec('COMMIT');

  console.log(
    `[ingest] from ${files.length} transcripts: sessions=${built.length} events=${nEvents} changed_files=${nFiles} hunks=${nHunks} attributions=${nAttr} event_files=${nEvFiles} annotations=${nAnn}`,
  );
}

main();
