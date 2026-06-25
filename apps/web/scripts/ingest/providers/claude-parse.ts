import * as path from 'node:path';
import { costForUsage } from '../../../lib/cost';
import type {
  Built,
  BuiltAnnotation,
  BuiltAttribution,
  BuiltEvent,
  BuiltEventFile,
  BuiltHunk,
} from '../built';
import { collectSessionCommits } from '../commit-sha';
import type { ProjectIdentity } from '../project';
import {
  clampLines,
  durationBetween,
  hhmmss,
  isCommit,
  isTest,
  langOf,
  lineCount,
  parseJsonlRecords,
  parseSubagentUsage,
  preview,
  toolTitle,
  toolType,
  type ClaudeContentBlock,
  type DraftChangedFile,
  type DraftEvent,
  type LooseRecord,
} from '../shared';
import { parseClaudeSubagentEvents } from './claude-subagents';
import type { ProviderBuildOptions } from './types';

export interface ClaudeSubagentTranscript {
  name: string;
  rawJsonl: string;
  metaRaw: string | null;
}

export function parseClaudeSessionRecords(
  recs: LooseRecord[],
  file: string,
  opts: ProviderBuildOptions,
  project: ProjectIdentity,
  subagents: ClaudeSubagentTranscript[] = [],
): Built | null {
  const { maxEvents, maxFiles, maxHunkLines } = opts;
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
                ? c.content.map((x: ClaudeContentBlock) => x?.text ?? '').join('\n')
                : '';
          results.set(c.tool_use_id, { isError: !!c.is_error, text, ts: r.timestamp });
        }
      }
    }
  }

  const events: BuiltEvent[] = [];
  const eventFiles: BuiltEventFile[] = [];
  const filesByPath = new Map<string, DraftChangedFile>();
  const hunks: BuiltHunk[] = [];
  const attributions: BuiltAttribution[] = [];
  const annotations: BuiltAnnotation[] = [];
  const agentLaunchers = new Map<string, string>(); // tool_use id -> launcher event id

  let seq = 0;
  let truncated = 0;
  let firstTs = '';
  let lastTs = '';
  let tokenUsage = 0;
  let tokenIn = 0;
  let tokenOut = 0;
  let costUsd = 0; // USD, priced from real per-message token usage (db/pricing.json)
  let costPriced = false; // true once a message resolves to a known price
  const counts: Record<string, number> = {};
  const loadedMemory = new Set<string>(); // de-dupe nested CLAUDE.md/AGENTS.md re-attached every turn

  const addEvent = (e: DraftEvent): BuiltEvent => {
    seq += 1;
    e.seq = seq;
    e.session_id = sessionId;
    e.id = `${sessionId}_${seq}`; // globally unique, overrides provided ids
    const ev = e as BuiltEvent;
    events.push(ev);
    counts[ev.type] = (counts[ev.type] || 0) + 1;
    return ev;
  };

  const ensureFile = (p: string, lang: string | null): DraftChangedFile => {
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
          .filter((c: ClaudeContentBlock) => c?.type === 'text')
          .map((c: ClaudeContentBlock) => c.text)
          .join('\n');
      }
      // strip slash-command xml wrappers for the headline
      const clean = text.replace(/<[^>]+>/g, ' ').trim();
      if (clean) {
        if (seq >= maxEvents) { truncated++; continue; }
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
        if (seq >= maxEvents) { truncated++; continue; }
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
          const metaObj: { tool: string; toolUses?: number } = { tool: name };
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
          if ((name === 'Write' || name === 'Edit' || name === 'MultiEdit') && fp && filesByPath.size < maxFiles) {
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
                content: clampLines(input.content || '', '+', maxHunkLines),
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
                  clampLines(ed.old_string || '', '-', maxHunkLines / 2) +
                  '\n' +
                  clampLines(ed.new_string || '', '+', maxHunkLines / 2);
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

  // ---- sub-agent transcripts ------------------------------------------------
  // Each Agent/Task launch writes its own transcript; meta.json.toolUseId links
  // it back to the launching tool_use. The fs shell supplies already-read
  // subagent JSONL/meta data so this parser remains deterministic and pure.
  for (const subagent of subagents) {
    let toolUseId: string | null = null;
    let agentType = 'sub-agent';
    try {
      const m = subagent.metaRaw ? JSON.parse(subagent.metaRaw) : null;
      toolUseId = m?.toolUseId || null;
      agentType = m?.agentType || agentType;
    } catch {
      /* no meta — skip */
    }
    if (!toolUseId) continue;
    const parentEventId = agentLaunchers.get(toolUseId);
    if (!parentEventId) continue; // launcher not in this session (shouldn't happen)
    const sa = parseClaudeSubagentEvents(
      parseJsonlRecords(subagent.rawJsonl),
      parentEventId,
      sessionId,
      agentType,
    );
    for (const ce of sa.children) events.push(ce);
    // stamp the launcher event with the sub-agent's model + cost so the
    // Subagents tab can show which model ran and what the run cost.
    const launcher = events.find((e) => e.id === parentEventId);
    if (launcher) {
      let lm: Record<string, unknown> = {};
      try {
        lm = launcher.meta ? JSON.parse(launcher.meta) : {};
      } catch {
        lm = {};
      }
      if (sa.model) lm.model = sa.model;
      if (sa.costUsd != null) lm.costUsd = sa.costUsd;
      if (sa.tokens != null) lm.tokens = sa.tokens;
      launcher.meta = JSON.stringify(lm);
    }
  }

  if (truncated) {
    addEvent({
      id: `trunc_${sessionId.slice(0, 8)}`, ts: lastTs ? hhmmss(lastTs) : '',
      type: 'todo', actor: 'system',
      title: `(表示上限 ${maxEvents} 件で打ち切り — 残り ${truncated} 件)`,
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
  const session: Built['session'] = {
    id: sessionId,
    projectId: project.id,
    project: project.displayName,
    projectGitRemote: project.gitRemote,
    projectCwdHint: project.cwdHint,
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
    harness_version_id: null,
    parent_session_id: null,
    spawned_by_seq: null,
    seq: 0,
    _startMs: firstTs ? new Date(firstTs).getTime() : 0,
  };

  // finalize changed file list (cap) — drop the private accumulators
  const changedFiles: Built['changedFiles'] = [...filesByPath.values()]
    .slice(0, maxFiles)
    .map(({ _hunkSeq, _firstWrite, ...f }) => f);

  const commitExtraction = collectSessionCommits(events);
  return {
    session,
    events,
    sessionCommits: commitExtraction.commits,
    commitShaMissCount: commitExtraction.unextractedEvents,
    eventFiles,
    changedFiles,
    hunks,
    attributions,
    annotations,
  };
}
