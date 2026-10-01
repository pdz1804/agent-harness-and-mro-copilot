/** Query-term highlighting for the KB document viewer. Pure so it can be
 * tested; mirrors the backend's tokenizer (`retrieval._tokenize`:
 * lowercase `[a-z0-9][a-z0-9_-]*`) so the terms the viewer marks are exactly
 * the terms BM25 scored on. */

export interface HighlightSegment {
  text: string
  match: boolean
}

export function tokenizeQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []
  return [...new Set(tokens)]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split `text` into alternating plain / matching segments for `terms`
 * (case-insensitive, whole-token matches — "pool" does not mark "pooling"). */
export function splitForHighlight(text: string, terms: string[]): HighlightSegment[] {
  const cleaned = terms.map((t) => t.trim()).filter(Boolean)
  if (!text) return []
  if (cleaned.length === 0) return [{ text, match: false }]
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_-])(${[...cleaned]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})(?![A-Za-z0-9_-])`,
    'gi',
  )
  const segments: HighlightSegment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ text: text.slice(last, index), match: false })
    segments.push({ text: match[0], match: true })
    last = index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false })
  return segments
}

export function countMatches(text: string, terms: string[]): number {
  return splitForHighlight(text, terms).filter((s) => s.match).length
}
