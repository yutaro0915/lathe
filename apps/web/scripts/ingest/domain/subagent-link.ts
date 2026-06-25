import type { Built } from '../built';

export interface SpawnLink {
  eventId: string;
  parentSessionId: string;
  childSessionId: string;
  spawnedBySeq: number;
}

export function spawnAgentIdFromMeta(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.agent_id === 'string'
      ? parsed.agent_id
      : null;
  } catch {
    return null;
  }
}

export function subagentLinkCandidates(built: Built[]): SpawnLink[] {
  const spawnLinks: SpawnLink[] = [];
  for (const b of built) {
    for (const e of b.events) {
      if (e.type !== 'subagent' || e.parent_id) continue;
      const childSessionId = spawnAgentIdFromMeta(e.meta);
      if (!childSessionId || childSessionId === b.session.id) continue;
      spawnLinks.push({
        eventId: e.id,
        parentSessionId: b.session.id,
        childSessionId,
        spawnedBySeq: e.seq,
      });
    }
  }
  return spawnLinks;
}
