import { costForUsage } from '../../../lib/cost';
import type { BuiltEvent } from '../built';
import {
  durationBetween,
  hhmmss,
  isCommit,
  isTest,
  parseSubagentUsage,
  preview,
  toolTitle,
  toolType,
  type ClaudeContentBlock,
  type DraftEvent,
  type LooseRecord,
} from '../shared';

export interface ClaudeSubagentParseResult {
  children: BuiltEvent[];
  model: string | null;
  costUsd: number | null;
  tokens: number | null;
}

// Parse an already-read sub-agent transcript into CHILD events linked to the
// launching Agent event. This is intentionally fs-free so unit tests can feed
// synthetic JSONL records directly.
export function parseClaudeSubagentEvents(
  recs: LooseRecord[],
  parentEventId: string,
  sessionId: string,
  agentLabel: string,
): ClaudeSubagentParseResult {
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

  const out: BuiltEvent[] = [];
  let saModel: string | null = null;
  let saIn = 0,
    saOut = 0,
    saCacheWrite = 0,
    saCacheRead = 0;
  let saSawUsage = false;
  let k = 0;
  const add = (e: DraftEvent) => {
    k += 1;
    const ev: BuiltEvent = {
      ...e,
      id: `${parentEventId}_c${k}`,
      session_id: sessionId,
      seq: k,
      parent_id: parentEventId,
      subagent: agentLabel,
    };
    out.push(ev);
  };

  for (const r of recs) {
    const ts = hhmmss(r.timestamp);
    if (r.type === 'user') {
      const c = r.message?.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c))
        t = c.filter((x: ClaudeContentBlock) => x?.type === 'text').map((x: ClaudeContentBlock) => x.text).join('\n');
      const clean = t.replace(/<[^>]+>/g, ' ').trim();
      if (clean)
        add({ ts, type: 'user_message', actor: 'user', title: preview(clean, 90), body: t.slice(0, 2000), file_path: null, command: null, exit_code: null, duration_ms: null, token_usage: null, meta: null });
    } else if (r.type === 'assistant') {
      if (!saModel && r.message?.model) saModel = r.message.model;
      const su = r.message?.usage;
      if (su) {
        saSawUsage = true;
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
  const tokens = saSawUsage ? saIn + saOut + saCacheWrite : null;
  return { children: out, model: saModel, costUsd, tokens };
}
