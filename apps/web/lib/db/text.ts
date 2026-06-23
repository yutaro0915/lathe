const EVIDENCE_EXCERPT_CHARS = 300;
export const EVIDENCE_NARRATIVE_CHARS = 200;

export function truncateExcerpt(value: string | null): string | null {
  return truncateTo(value, EVIDENCE_EXCERPT_CHARS);
}

export function truncateTo(value: string | null, chars: number): string | null {
  if (value == null) return null;
  const compact = value.replace(/\s+$/g, '');
  if (!compact) return null;
  return compact.length <= chars ? compact : `${compact.slice(0, chars - 1)}…`;
}

// One line of a body/title, trimmed — used for the trigger / aftermath summaries
// where a single readable line beats a multi-line dump.
export function firstLine(value: string | null): string | null {
  if (value == null) return null;
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}
