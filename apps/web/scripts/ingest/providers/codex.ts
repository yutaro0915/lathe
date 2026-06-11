import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { costForUsage } from '../../../lib/cost';
import type { Built } from '../built';
import { collectSessionCommits } from '../commit-sha';
import { resolveProjectIdentity } from '../project';
import {
  clampLines,
  hhmmss,
  isCommit,
  isTest,
  lineCount,
  preview,
  type LooseRecord,
} from '../shared';
import type { ProviderBuildOptions, TranscriptProvider } from './types';

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

export function buildCodexSession(file: string, titles: Map<string, string>, opts: ProviderBuildOptions): Built | null {
  const { maxFiles, maxHunkLines } = opts;
  const recs: LooseRecord[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
  if (!recs.length) return null;
  const meta = recs.find((r) => r.type === 'session_meta')?.payload;
  if (!meta) return null;
  const cwd = meta.cwd || '';
  const sessionId = meta.id || path.basename(file, '.jsonl');
  const model = recs.find((r) => r.type === 'turn_context')?.payload?.model || meta.model || 'codex';
  const gitBranch = meta.git?.branch || '';

  // join function_call <-> output and apply_patch <-> patch_apply_end by call_id
  const callOut = new Map<string, LooseRecord>();
  const patchEnd = new Map<string, LooseRecord>();
  for (const r of recs) {
    if (r.type === 'response_item' && r.payload?.type === 'function_call_output' && r.payload.call_id) callOut.set(r.payload.call_id, r.payload);
    if (r.type === 'event_msg' && r.payload?.type === 'patch_apply_end' && r.payload.call_id) patchEnd.set(r.payload.call_id, r.payload);
  }

  const events: LooseRecord[] = [];
  const eventFiles: LooseRecord[] = [];
  const filesByPath = new Map<string, LooseRecord>();
  const hunks: LooseRecord[] = [];
  const attributions: LooseRecord[] = [];
  const annotations: LooseRecord[] = [];
  let seq = 0, firstTs = '', lastTs = '';
  let tokenIn = 0, tokenOut = 0, tokenUsage = 0, cachedInput = 0;
  const counts: Record<string, number> = {};
  const addEvent = (e: LooseRecord) => {
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
      const sum = Array.isArray(p.summary) ? p.summary.map((x: LooseRecord) => x?.text ?? '').filter(Boolean).join('\n\n') : '';
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
      let args: LooseRecord = {}; try { args = JSON.parse(p.arguments || '{}'); } catch { /* keep {} */ }
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
        hunks.push({ id: hid, file_id: f.id, seq: f._hunkSeq, header: `@@ ${isAdd ? 'Add' : isDel ? 'Delete' : 'Update'} ${fp} (+${adds}) @@`, content: clampLines(content, '+', maxHunkLines) });
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
  const project = resolveProjectIdentity(cwd, cwd ? path.basename(cwd) : 'LLMWiki');

  const session: Built['session'] = {
    id: sessionId,
    projectId: project.id,
    project: project.displayName,
    projectGitRemote: project.gitRemote,
    projectCwdHint: project.cwdHint,
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
  const changedFiles = [...filesByPath.values()].slice(0, maxFiles).map((f) => { delete f._hunkSeq; return f; });

  return {
    session,
    events: events as Built['events'],
    sessionCommits: collectSessionCommits(events as Built['events']),
    eventFiles: eventFiles as Built['eventFiles'],
    changedFiles: changedFiles as Built['changedFiles'],
    hunks: hunks as Built['hunks'],
    attributions: attributions as Built['attributions'],
    annotations: annotations as Built['annotations'],
  };
}

export class CodexProvider implements TranscriptProvider {
  readonly name = 'codex' as const;
  private readonly titles = loadCodexTitles();

  constructor(
    private readonly codexProject: string,
    private readonly maxSessions: number,
    private readonly opts: ProviderBuildOptions,
  ) {}

  discover(): string[] {
    return listCodexRollouts()
      .filter((f) => {
        const cwd = codexHeadCwd(f);
        return cwd != null && path.basename(cwd) === this.codexProject;
      })
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, this.maxSessions)
      .map((x) => x.p);
  }

  build(file: string): Built | null {
    return buildCodexSession(file, this.titles, this.opts);
  }
}
