import type { KBDoc } from './api-types'

export const MIN_DOC_CHARS = 20
export const MAX_FILE_BYTES = 200_000
export const KB_SORT_COLUMNS = ['title', 'chunks', 'size', 'kind'] as const

/** Case-insensitive match on title or id; an empty query keeps everything. */
export function filterDocs(docs: readonly KBDoc[], query: string): KBDoc[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...docs]
  return docs.filter((d) => d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q))
}

/** "Seed runbook" (read-only, shipped with the app) or "Added" (uploaded by a user). */
export function docKindLabel(doc: Pick<KBDoc, 'source'>): string {
  return doc.source === 'upload' ? 'Added' : 'Seed runbook'
}

export function docSortKey(doc: KBDoc, column: string): string | number | null {
  switch (column) {
    case 'title':
      return doc.title
    case 'chunks':
      return doc.chunk_count ?? null
    case 'size':
      return doc.chars ?? null
    case 'kind':
      return docKindLabel(doc)
    default:
      return null
  }
}

/** Index of the next/previous item with wrap-around; `current` -1 (not in the
 * list) steps to the first or last item. */
export function stepIndex(length: number, current: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : length - 1
  return (current + delta + length) % length
}

/** An error message for the document body, or null when it can be indexed. */
export function validateDocContent(content: string): string | null {
  const length = content.trim().length
  if (length < MIN_DOC_CHARS) return `Write at least ${MIN_DOC_CHARS} characters so there is something to retrieve.`
  return null
}

/** An error message for a file that is too large to load, else null. */
export function validateFileSize(bytes: number): string | null {
  if (bytes <= MAX_FILE_BYTES) return null
  return `That file is ${Math.round(bytes / 1000)} KB; the limit is ${MAX_FILE_BYTES / 1000} KB.`
}
