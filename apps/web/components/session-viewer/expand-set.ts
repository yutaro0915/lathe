export function toggleInSet(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function addToSet(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return new Set(set);
  const next = new Set(set);
  next.add(id);
  return next;
}
