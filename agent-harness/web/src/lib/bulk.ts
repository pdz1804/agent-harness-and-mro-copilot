/** Run one async mutation per id (in parallel) and report which succeeded,
 * so a bulk action with partial failures can say exactly that ("Archived 4 ·
 * 1 failed") and Undo only what actually changed. */
export interface BulkResult {
  ok: string[]
  failed: { id: string; error: unknown }[]
}

export async function runBulk(ids: readonly string[], fn: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const settled = await Promise.allSettled(ids.map((id) => fn(id)))
  const result: BulkResult = { ok: [], failed: [] }
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') result.ok.push(ids[i])
    else result.failed.push({ id: ids[i], error: s.reason })
  })
  return result
}

/** "Archived 3 sessions" / "Archived 1 session · 2 failed". */
export function bulkSummary(verb: string, noun: string, result: BulkResult): string {
  const n = result.ok.length
  const base = `${verb} ${n} ${noun}${n === 1 ? '' : 's'}`
  return result.failed.length ? `${base} · ${result.failed.length} failed` : base
}

/** Toggle one id in a selection set (immutable). */
export function toggleId(selected: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** Keep only ids still present (rows vanish when filters or polls change). */
export function pruneSelection(selected: ReadonlySet<string>, present: readonly string[]): Set<string> {
  const keep = new Set(present)
  const next = new Set<string>()
  for (const id of selected) if (keep.has(id)) next.add(id)
  return next.size === selected.size ? (selected as Set<string>) : next
}
