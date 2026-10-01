/** Pure ranking logic for the Ctrl+K command palette. */

export interface PaletteItem {
  /** Stable id (also the React key). */
  id: string
  label: string
  /** Where it goes: a hash route such as `/sessions` or `/runs/abc`. */
  to: string
  group: 'Actions' | 'Pages' | 'Sessions' | 'Approvals'
  /** Extra words that should also match (route name, status, agent...). */
  keywords?: string
  /** Quiet secondary text shown to the right. */
  hint?: string
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')

/** Score how well `query` matches `text` (higher is better, 0 = no match).
 * Every query word must match somewhere: a prefix of a word scores highest, a
 * substring less, and an in-order subsequence of characters least. Earlier
 * matches and shorter texts win ties. */
export function scoreMatch(query: string, text: string): number {
  const q = normalize(query).trim()
  if (!q) return 1
  const t = normalize(text)
  const words = t.split(/[^a-z0-9]+/).filter(Boolean)
  let total = 0
  for (const part of q.split(/\s+/)) {
    let best = 0
    if (words.some((w) => w.startsWith(part))) best = 100
    else if (t.includes(part)) best = 60
    else if (isSubsequence(part, t)) best = 25
    if (best === 0) return 0
    const at = t.indexOf(part)
    total += best - Math.min(20, at < 0 ? 10 : at)
  }
  return Math.max(1, total - Math.min(15, Math.floor(t.length / 12)))
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/** Items matching `query`, best first (label weighs more than keywords/hint);
 * with an empty query the original order is kept. `limit` caps the list. */
export function rankItems(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  if (!query.trim()) return items.slice(0, limit)
  const scored: { item: PaletteItem; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const label = scoreMatch(query, item.label)
    const extra = scoreMatch(query, `${item.keywords ?? ''} ${item.hint ?? ''}`)
    const score = Math.max(label * 2, extra)
    if (score > 0) scored.push({ item, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.item)
}

/** Move the highlighted index with the arrow keys, wrapping at both ends. */
export function moveIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0
  return (current + delta + length) % length
}

/** Whether a keydown is the palette shortcut (Ctrl+K or Cmd+K). */
export function isPaletteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k'
}
