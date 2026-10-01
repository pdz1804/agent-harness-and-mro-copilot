/** Keys whose signature changed (or that are new) between two list loads.
 * Drives the brief highlight flash on rows a live refresh changed. The very
 * first load (prev === null) flashes nothing. */
export function changedKeys<T>(prev: ReadonlyMap<string, string> | null, rows: readonly T[], key: (r: T) => string, sig: (r: T) => string): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  for (const r of rows) {
    const k = key(r);
    const before = prev.get(k);
    if (before === undefined || before !== sig(r)) out.add(k);
  }
  return out;
}

export function signatureMap<T>(rows: readonly T[], key: (r: T) => string, sig: (r: T) => string): Map<string, string> {
  return new Map(rows.map((r) => [key(r), sig(r)]));
}

/** Apply optimistic status overrides to rows without mutating them. */
export function withOverrides<T extends { status: string }>(rows: readonly T[], key: (r: T) => string, overrides: ReadonlyMap<string, string>): T[] {
  if (overrides.size === 0) return rows as T[];
  return rows.map((r) => {
    const o = overrides.get(key(r));
    return o && o !== r.status ? { ...r, status: o } : r;
  });
}

/** Free-text match across the given fields (case-insensitive, all words). */
export function matchesQuery(fields: (string | number | null | undefined)[], q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter((f) => f != null).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
