import type { BuiltEvent } from './built';

export interface BuiltSessionCommit {
  session_id: string;
  sha: string;
  event_id: string | null;
  source: string;
}

export interface CommitExtractionResult {
  commits: BuiltSessionCommit[];
  unextractedEvents: number;
}

const COMMIT_OUTPUT_RE = /^\[[^\]\n]*\s([0-9a-f]{7,40})\]\s+.+$/gim;

export function extractCommitOutputShas(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(COMMIT_OUTPUT_RE)) {
    out.add(match[1].toLowerCase());
  }
  return [...out];
}

export function collectSessionCommits(events: BuiltEvent[]): CommitExtractionResult {
  const commits: BuiltSessionCommit[] = [];
  const seen = new Set<string>();
  let unextractedEvents = 0;
  for (const event of events) {
    if (event.type !== 'commit') continue;
    const shas = extractCommitOutputShas(event.body);
    if (shas.length === 0) unextractedEvents++;
    for (const sha of shas) {
      const key = `${event.session_id}:${sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commits.push({
        session_id: event.session_id,
        sha,
        event_id: event.id,
        source: 'commit_event',
      });
    }
  }
  return { commits, unextractedEvents };
}
