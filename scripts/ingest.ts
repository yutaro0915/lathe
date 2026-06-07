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
import { costForUsage } from '../lib/cost';

// Default to the user's most-recently-active Claude project (no hard-coded
// username/path, so the tool works for anyone). Claude Code stores one dir per
// project at ~/.claude/projects/<cwd-with-slashes-as-dashes>. Override with
// argv[2] or LATHE_TRANSCRIPTS_DIR.
function pickDefaultTranscriptsDir(): string {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    const dirs = fs
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
    if (dirs.length) return dirs[0].full;
  } catch { /* ignore */ }
  return base;
}

// The repo/project name = last segment of the Claude project dir name
// (e.g. "-Users-you-myrepo" -> "myrepo"). Used to scope Codex by cwd.
function repoBasenameOf(transcriptsDir: string): string {
  const segs = path.basename(transcriptsDir).split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : 'project';
}

const TRANSCRIPTS_DIR =
  process.argv[2] ||
  process.env.LATHE_TRANSCRIPTS_DIR ||
  pickDefaultTranscriptsDir();
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
): { children: any[]; model: string | null; costUsd: number | null } {
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
    return { children: [], model: null, costUsd: null };
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
  // roll up the sub-agent's own model + token usage so we can show which model
  // ran and what the run cost (the sub-agent transcript carries per-message
  // model + usage; the launcher event in the parent does not).
  let saModel: string | null = null;
  let saIn = 0,
    saOut = 0,
    saCacheWrite = 0,
    saCacheRead = 0;
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
      if (!saModel && r.message?.model) saModel = r.message.model;
      const su = r.message?.usage;
      if (su) {
        saIn += su.input_tokens || 0;
        saOut += su.output_tokens || 0;
        saCacheWrite += su.cache_creation_input_tokens || 0;
        saCacheRead += su.cache_read_input_tokens || 0;
      }
      const c = r.message?.content;
      if (!Array.isArray(c)) continue;
      for (const x of c) {
        if (x.type === 'text' && x.text?.trim()) {
          add({ ts, type: 'assistant_message', actor: 'subagent', title: preview(x.text, 90), body: x.text.slice(0, 2000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
        } else if (x.type === 'thinking' && x.thinking?.trim()) {
          add({ ts, type: 'thinking', actor: 'subagent', title: preview(x.thinking, 90), body: x.thinking.slice(0, 8000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
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
  const costUsd = costForUsage(saModel, {
    input: saIn,
    output: saOut,
    cacheWrite: saCacheWrite,
    cacheRead: saCacheRead,
  });
  return { children: out, model: saModel, costUsd };
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
  let costUsd = 0; // USD, priced from real per-message token usage (db/pricing.json)
  let costPriced = false; // did any message resolve to a known price? else cost = null
  const counts: Record<string, number> = {};
  const loadedMemory = new Set<string>(); // de-dupe nested CLAUDE.md/AGENTS.md re-attached every turn

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
        // Cost: price ALL FOUR token categories (incl. cache_read, which the
        // token totals above intentionally omit but which IS billed) by THIS
        // message's model — per-message pricing matches ccusage and is correct
        // when sub-agents use a different model than the main one.
        const c = costForUsage(r.message?.model, {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cacheWrite: usage.cache_creation_input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
        });
        if (c != null) {
          costUsd += c;
          costPriced = true;
        }
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
        } else if (c.type === 'thinking' && c.thinking?.trim()) {
          // extended-thinking text (when not redacted to a signature-only block)
          addEvent({
            id: (r.uuid || `a_${seq}`) + ':k',
            ts, type: 'thinking', actor: 'assistant',
            title: preview(c.thinking, 90), body: c.thinking.slice(0, 8000),
            file_path: null, command: null, exit_code: null,
            duration_ms: null, token_usage: null,
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

    // ----- harness signals (attachment records the loop used to drop) -----
    // nested CLAUDE.md/AGENTS.md context loads + hook firings. NOTE: the ROOT
    // CLAUDE.md/AGENTS.md is injected at runtime and NOT persisted to the JSONL,
    // so only *nested* memory files are observable here.
    if (r.type === 'attachment' && r.attachment) {
      const a = r.attachment;
      if (a.type === 'nested_memory' && a.path) {
        if (!loadedMemory.has(a.path)) {
          loadedMemory.add(a.path);
          addEvent({
            ts, type: 'memory', actor: 'system',
            title: `Memory · ${a.displayPath ?? a.path}`,
            body: typeof a.content?.content === 'string' ? a.content.content.slice(0, 4000) : null,
            file_path: a.path, command: null, exit_code: null,
            duration_ms: null, token_usage: null, subagent: null,
            meta: JSON.stringify({ kind: 'nested_memory', tier: a.content?.type ?? null, displayPath: a.displayPath ?? null }),
          });
        }
      } else if (a.type === 'hook_success' || a.type === 'hook_additional_context') {
        const content = Array.isArray(a.content) ? a.content.join('\n') : (a.content ?? '');
        const extra = a.hookName && a.hookName !== a.hookEvent ? ` (${a.hookName})` : '';
        addEvent({
          ts, type: 'hook', actor: 'system',
          title: `Hook · ${a.hookEvent ?? 'hook'}${extra}`,
          body: ((a.stdout || content) ?? '').slice(0, 3000) || null,
          file_path: null, command: a.command ?? null,
          exit_code: typeof a.exitCode === 'number' ? a.exitCode : null,
          duration_ms: typeof a.durationMs === 'number' ? a.durationMs : null,
          token_usage: null, subagent: null,
          meta: JSON.stringify({ kind: 'hook', hookEvent: a.hookEvent ?? null, hookName: a.hookName ?? null, toolUseID: a.toolUseID ?? null }),
        });
      }
      continue;
    }
    // other line types (system / titles / queue) -> metadata only
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
      const sa = extractChildEvents(path.join(subDir, saName), parentEventId, sessionId, agentType);
      for (const ce of sa.children) events.push(ce);
      // stamp the launcher event with the sub-agent's model + cost so the
      // Subagents tab can show which model ran and what the run cost.
      const launcher = events.find((e) => e.id === parentEventId);
      if (launcher) {
        let lm: any = {};
        try {
          lm = launcher.meta ? JSON.parse(launcher.meta) : {};
        } catch {
          lm = {};
        }
        if (sa.model) lm.model = sa.model;
        if (sa.costUsd != null) lm.costUsd = sa.costUsd;
        launcher.meta = JSON.stringify(lm);
      }
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
  // grounded signal: how many tool calls actually returned a non-zero exit (or
  // were error events), across the session + its sub-agents. NOT a vague
  // "session failed" verdict — there is no such thing in a transcript.
  const errorCount = events.filter(
    (e) => (e.exit_code != null && e.exit_code !== 0) || e.type === 'error',
  ).length;
  const status = errorCount > 0 ? 'failed' : 'done';

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
    error_count: errorCount,
    token_usage: tokenUsage,
    token_in: tokenIn,
    token_out: tokenOut,
    git_branch: gitBranch || null,
    commit_count: counts['commit'] || 0,
    cost_usd: costPriced ? costUsd : null, // priced from real tokens (db/pricing.json); null if model unknown
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

// ----- Codex rollout ingester -----------------------------------------------
// Codex stores sessions at ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl (+ an
// archived_sessions/ dir). Each line is { timestamp, type, payload }. We map the
// SAME repo's sessions (by cwd) into lathe's schema with runner='codex'. Notes:
// cost is null (db/pricing.json only covers Claude); `reasoning` is encrypted
// (no thinking text); there is no read tool (file reads are inferred from cat/sed).

function codexLangOf(p: string): string | null {
  const ext = p.split('.').pop()?.toLowerCase();
  const m: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python',
    sql: 'sql', css: 'css', md: 'markdown', json: 'json', sh: 'bash', mjs: 'javascript', html: 'html',
  };
  return (ext && m[ext]) || null;
}

// Pull the read target out of a shell read (`sed -n '1,220p' hot.md`,
// `cat memory/USER.md`, `head -40 lib/db.ts`) and resolve it against the session
// cwd so Codex reads carry an absolute path like Claude's file_read events.
function codexReadPath(cmd: string, cwd: string): string | null {
  const stripped = cmd.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ').trim();
  const parts = stripped.split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i];
    if (t && !t.startsWith('-') && t !== '|' && /[./]/.test(t) && !/^\d/.test(t)) {
      return path.isAbsolute(t) ? t : path.join(cwd || '', t);
    }
  }
  return null;
}

// Codex has no dedicated skill tool: a skill is invoked by reading its SKILL.md
// (e.g. `sed -n '1,220p' ~/.codex/skills/.system/openai-docs/SKILL.md`). Pull the
// skill name (the SKILL.md's parent dir) so that read surfaces as a first-class
// `skill` event, like Claude's Skill tool.
function codexSkillName(cmd: string): string | null {
  const m = cmd.match(/\.codex\/skills\/(?:[^\s'"]*\/)?([^/\s'"]+)\/SKILL\.md/);
  return m ? m[1] : null;
}

function listCodexRollouts(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
    }
  };
  for (const r of [path.join(os.homedir(), '.codex', 'sessions'), path.join(os.homedir(), '.codex', 'archived_sessions')]) {
    if (fs.existsSync(r)) walk(r);
  }
  return out;
}

// Cheap cwd probe (read only the head) so we can filter 1000+ rollouts without
// reading every file in full. The session_meta line can be tens of KB (it embeds
// instructions), so we regex the cwd out of the head bytes rather than JSON.parse
// a possibly-truncated first line. cwd sits near the start of session_meta.
function codexHeadCwd(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.slice(0, n).toString('utf8'));
    return m ? m[1].replace(/\\\//g, '/') : null;
  } catch {
    return null;
  }
}

function loadCodexTitles(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const lines = fs.readFileSync(path.join(os.homedir(), '.codex', 'session_index.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) { try { const r = JSON.parse(l); if (r.id && r.thread_name) m.set(r.id, r.thread_name); } catch { /* skip */ } }
  } catch { /* no index */ }
  return m;
}

function buildCodexSession(file: string, titles: Map<string, string>): Built | null {
  const recs: any[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
  if (!recs.length) return null;
  const meta = recs.find((r) => r.type === 'session_meta')?.payload;
  if (!meta) return null;
  const cwd = meta.cwd || '';
  const sessionId = meta.id || path.basename(file, '.jsonl');
  const model = recs.find((r) => r.type === 'turn_context')?.payload?.model || meta.model || 'codex';
  const gitBranch = meta.git?.branch || '';

  // join function_call <-> output and apply_patch <-> patch_apply_end by call_id
  const callOut = new Map<string, any>();
  const patchEnd = new Map<string, any>();
  for (const r of recs) {
    if (r.type === 'response_item' && r.payload?.type === 'function_call_output' && r.payload.call_id) callOut.set(r.payload.call_id, r.payload);
    if (r.type === 'event_msg' && r.payload?.type === 'patch_apply_end' && r.payload.call_id) patchEnd.set(r.payload.call_id, r.payload);
  }

  const events: any[] = [];
  const eventFiles: any[] = [];
  const filesByPath = new Map<string, any>();
  const hunks: any[] = [];
  const attributions: any[] = [];
  const annotations: any[] = [];
  let seq = 0, firstTs = '', lastTs = '';
  let tokenIn = 0, tokenOut = 0, tokenUsage = 0, cachedInput = 0;
  const counts: Record<string, number> = {};
  const addEvent = (e: any) => {
    seq += 1; e.seq = seq; e.session_id = sessionId; e.id = `${sessionId}_${seq}`;
    e.subagent = e.subagent ?? null; e.parent_id = null;
    events.push(e); counts[e.type] = (counts[e.type] || 0) + 1; return e;
  };
  const ensureFile = (p: string) => {
    let f = filesByPath.get(p);
    if (!f) { f = { id: `chf_${sessionId}_${filesByPath.size + 1}`, session_id: sessionId, path: p, status: 'modified', additions: 0, deletions: 0, language: codexLangOf(p), seq: filesByPath.size + 1, _hunkSeq: 0 }; filesByPath.set(p, f); }
    return f;
  };

  for (const r of recs) {
    if (r.timestamp) { if (!firstTs) firstTs = r.timestamp; lastTs = r.timestamp; }
    const ts = hhmmss(r.timestamp);
    const p = r.payload;
    if (!p) continue;

    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      // cumulative across the session — keep the latest as the total. Exclude
      // cached input (the cache-read analog) to match the Claude token metric.
      const u = p.info.total_token_usage;
      const fresh = Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
      tokenIn = fresh; tokenOut = u.output_tokens || 0; tokenUsage = fresh + (u.output_tokens || 0);
      cachedInput = u.cached_input_tokens || 0; // billed at the cache-read rate
      continue;
    }
    if (r.type === 'response_item' && p.type === 'reasoning') {
      // raw reasoning is encrypted; the SUMMARY (when present) is the visible
      // thinking — emit a thinking event only when there is real summary text.
      const sum = Array.isArray(p.summary) ? p.summary.map((x: any) => x?.text ?? '').filter(Boolean).join('\n\n') : '';
      if (sum.trim()) addEvent({ ts, type: 'thinking', actor: 'assistant', title: preview(sum, 90), body: sum.slice(0, 8000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
      continue;
    }
    if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
      addEvent({ ts, type: 'user_message', actor: 'user', title: preview(p.message, 90), body: p.message.slice(0, 4000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
      continue;
    }
    if (r.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
      addEvent({ ts, type: 'assistant_message', actor: 'assistant', title: preview(p.message, 90), body: p.message.slice(0, 4000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
      continue;
    }
    if (r.type === 'response_item' && p.type === 'function_call') {
      const name = p.name as string;
      let args: any = {}; try { args = JSON.parse(p.arguments || '{}'); } catch { /* keep {} */ }
      const out = p.call_id ? callOut.get(p.call_id) : null;
      // output is usually a string, but image/structured outputs come back as
      // arrays/objects — coerce to '' so we never bind a non-string body.
      const outText: string = typeof out?.output === 'string' ? out.output : '';
      if (name === 'exec_command') {
        const cmd: string = args.cmd || (Array.isArray(args.command) ? args.command.join(' ') : '') || '';
        const em = /exited with code (\d+)/.exec(outText);
        const exit = em ? Number(em[1]) : null;
        const oi = outText.indexOf('Output:');
        const stdout = oi >= 0 ? outText.slice(oi + 7).replace(/^\n/, '') : outText;
        let etype = 'bash';
        let readPath: string | null = null;
        let skillName: string | null = null;
        if (isCommit(cmd)) etype = 'commit';
        else if (isTest(cmd)) etype = 'test';
        else if (/^\s*(cat|sed -n|head|tail|bat|less)\b/.test(cmd)) {
          // Codex has no read tool — file reads run as shell (cat/sed/head/…).
          // Pull the file out so the read is first-class (path + linked files).
          etype = 'file_read';
          readPath = codexReadPath(cmd, cwd);
          // ...and reading a skill's SKILL.md IS how Codex invokes a skill —
          // promote it to a `skill` event (keep the path) so it shows up in the
          // Skills tab and /stats, like Claude's Skill tool.
          skillName = codexSkillName(cmd);
          if (skillName) etype = 'skill';
        }
        const ev = addEvent({ ts, type: etype, actor: 'assistant', title: skillName ? `Skill · ${skillName}` : preview(cmd, 80), body: stdout.slice(0, 3000), file_path: readPath, command: cmd, exit_code: exit, duration_ms: null, token_usage: null, meta: JSON.stringify(skillName ? { tool: 'exec_command', skill: skillName } : { tool: 'exec_command' }) });
        if (readPath) eventFiles.push({ event_id: ev.id, path: readPath, role: 'read' });
        if (exit != null && exit !== 0) annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'error', note: preview(cmd, 60) });
        else if (etype === 'commit') annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'commit', note: preview(cmd, 60) });
        else if (etype === 'test') annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'test', note: preview(cmd, 60) });
      } else if (name === 'update_plan') {
        addEvent({ ts, type: 'todo', actor: 'assistant', title: 'Plan update', body: preview(JSON.stringify(args.plan ?? args), 400), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: JSON.stringify({ tool: 'update_plan' }) });
      } else if (name === 'spawn_agent') {
        addEvent({ ts, type: 'subagent', actor: 'assistant', title: `Sub-agent · ${args.agent_type ?? ''}`, body: preview(JSON.stringify(args), 300), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, subagent: args.agent_type || 'sub-agent', meta: JSON.stringify({ tool: 'spawn_agent' }) });
      } else {
        addEvent({ ts, type: 'bash', actor: 'assistant', title: name, body: outText.slice(0, 1000) || preview(JSON.stringify(args), 200), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: JSON.stringify({ tool: name }) });
      }
      continue;
    }
    if (r.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      const pe = p.call_id ? patchEnd.get(p.call_id) : null;
      const changes = pe?.changes || {};
      for (const fp of Object.keys(changes)) {
        const ch = changes[fp] || {};
        const isAdd = ch.type === 'add';
        const isDel = ch.type === 'delete';
        const etype = isAdd ? 'file_write' : 'file_edit';
        const content: string = typeof ch.content === 'string' ? ch.content : '';
        const adds = lineCount(content);
        const ev = addEvent({ ts, type: etype, actor: 'assistant', title: `File ${isAdd ? 'write' : isDel ? 'delete' : 'edit'} · ${fp}`, body: content.slice(0, 3000) || (isDel ? '(deleted)' : ''), file_path: fp, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: JSON.stringify({ tool: 'apply_patch', change: ch.type }) });
        eventFiles.push({ event_id: ev.id, path: fp, role: isAdd ? 'write' : 'edit' });
        const f = ensureFile(fp);
        f.additions += adds;
        if (isAdd) f.status = 'added'; else if (isDel) f.status = 'deleted';
        f._hunkSeq += 1;
        const hid = `${f.id}_h${f._hunkSeq}`;
        hunks.push({ id: hid, file_id: f.id, seq: f._hunkSeq, header: `@@ ${isAdd ? 'Add' : isDel ? 'Delete' : 'Update'} ${fp} (+${adds}) @@`, content: clampLines(content, '+', MAX_HUNK_LINES) });
        attributions.push({ id: `att_${hid}`, hunk_id: hid, event_id: ev.id, confidence: 'high', method: 'edit_event', note: 'Codex apply_patch' });
        annotations.push({ session_id: sessionId, at_seq: ev.seq, kind: 'edit', note: preview(fp, 60) });
      }
      continue;
    }
    // reasoning (encrypted), response_item message (developer/role), turn_context -> skip
  }

  if (!events.length) return null;

  const durationMs = firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : null;
  const errorCount = events.filter((e) => (e.exit_code != null && e.exit_code !== 0) || e.type === 'error').length;
  const title = titles.get(sessionId) || events.find((e) => e.type === 'user_message')?.title || '(codex session)';
  // cost from real GPT pricing: fresh input + cached (at cache-read rate) + output.
  // null for unpriceable models (e.g. codex-auto-review) -> shown as "—".
  const costUsd = costForUsage(model, { input: tokenIn, output: tokenOut, cacheWrite: 0, cacheRead: cachedInput });

  const session = {
    id: sessionId,
    project: cwd ? path.basename(cwd) : 'LLMWiki',
    title,
    runner: 'codex',
    model,
    status: errorCount > 0 ? 'failed' : 'done',
    started_at: firstTs ? firstTs.replace('T', ' ').slice(0, 19) : '',
    ended_at: lastTs ? lastTs.replace('T', ' ').slice(0, 19) : null,
    duration_ms: durationMs,
    turn_count: counts['user_message'] || 0,
    tool_count: events.filter((e) => e.command !== null || (e.meta && e.meta.includes('tool'))).length,
    edit_count: (counts['file_edit'] || 0) + (counts['file_write'] || 0),
    bash_count: counts['bash'] || 0,
    subagent_count: counts['subagent'] || 0,
    error_count: errorCount,
    token_usage: tokenUsage,
    token_in: tokenIn,
    token_out: tokenOut,
    git_branch: gitBranch || null,
    commit_count: counts['commit'] || 0,
    cost_usd: costUsd, // priced from bundled GPT rates; null when model unknown
    summary: meta.cli_version ? `codex ${meta.cli_version}` : 'codex',
    seq: 0,
    _startMs: firstTs ? new Date(firstTs).getTime() : 0,
  };
  const changedFiles = [...filesByPath.values()].slice(0, MAX_FILES).map((f) => { delete f._hunkSeq; return f; });

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

  // ----- Codex sessions (same repo, by cwd). runner='codex', cost=null. -----
  let codexCount = 0;
  if (process.env.LATHE_NO_CODEX !== '1') {
    const codexProject = process.env.LATHE_CODEX_PROJECT || repoBasenameOf(TRANSCRIPTS_DIR);
    const titles = loadCodexTitles();
    const codexFiles = listCodexRollouts()
      .filter((f) => { const c = codexHeadCwd(f); return c != null && path.basename(c) === codexProject; })
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SESSIONS)
      .map((x) => x.p);
    for (const f of codexFiles) {
      try {
        const b = buildCodexSession(f, titles);
        if (b && b.events.length) { built.push(b); codexCount++; }
      } catch (e) {
        console.error(`[ingest] codex failed on ${path.basename(f)}: ${(e as Error).message}`);
      }
    }
  }

  // order sessions newest-first; seq 1 = primary (most recent)
  built.sort((a, b) => b.session._startMs - a.session._startMs);
  built.forEach((b, i) => (b.session.seq = i + 1));

  const insSession = db.prepare(
    `INSERT INTO sessions (id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    insSession.run(s.id, s.project, s.title, s.runner, s.model, s.status, s.started_at, s.ended_at, s.duration_ms, s.turn_count, s.tool_count, s.edit_count, s.bash_count, s.subagent_count, s.error_count, s.token_usage, s.token_in, s.token_out, s.git_branch, s.commit_count, s.cost_usd, s.summary, s.seq);
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
    `[ingest] from ${files.length} claude transcripts + ${codexCount} codex sessions: sessions=${built.length} events=${nEvents} changed_files=${nFiles} hunks=${nHunks} attributions=${nAttr} event_files=${nEvFiles} annotations=${nAnn}`,
  );
}

main();
