import type { BuiltEvent } from './built';

export interface BuiltSessionCommit {
  session_id: string;
  sha: string;
  event_id: string | null;
  source: string;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;

export function extractCommitShas(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(SHA_RE)) {
    const sha = match[0].toLowerCase();
    if (/[a-f]/.test(sha)) out.add(sha);
  }
  return [...out];
}

export function collectSessionCommits(events: BuiltEvent[]): BuiltSessionCommit[] {
  const out: BuiltSessionCommit[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'commit') continue;
    const shas = extractCommitShas([event.command, event.title, event.body].filter(Boolean).join('\n'));
    for (const sha of shas) {
      const key = `${event.session_id}:${sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        session_id: event.session_id,
        sha,
        event_id: event.id,
        source: 'commit_event',
      });
    }
  }
  return out;
}
