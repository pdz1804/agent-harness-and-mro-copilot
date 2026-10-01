import { describe, expect, it } from 'vitest'
import { docKindLabel, docSortKey, filterDocs, stepIndex, validateDocContent, validateFileSize } from '../src/lib/kb-docs'
import type { KBDoc } from '../src/lib/api-types'

const docs: KBDoc[] = [
  { id: 'kb-auth', title: 'Auth outage runbook', source: 'seed', chunk_count: 4, chars: 3200 },
  { id: 'kb-up-1', title: 'Payments notes', source: 'upload', chunk_count: 2, chars: 900 },
]

describe('kb-docs', () => {
  it('filters by title or id, case-insensitively', () => {
    expect(filterDocs(docs, 'AUTH').map((d) => d.id)).toEqual(['kb-auth'])
    expect(filterDocs(docs, 'up-1').map((d) => d.id)).toEqual(['kb-up-1'])
    expect(filterDocs(docs, '  ')).toHaveLength(2)
    expect(filterDocs(docs, 'zzz')).toHaveLength(0)
  })

  it('labels the kind and exposes sort keys', () => {
    expect(docKindLabel(docs[0])).toBe('Seed runbook')
    expect(docKindLabel(docs[1])).toBe('Added')
    expect(docSortKey(docs[0], 'chunks')).toBe(4)
    expect(docSortKey(docs[1], 'size')).toBe(900)
    expect(docSortKey(docs[0], 'unknown')).toBeNull()
  })

  it('steps with wrap-around', () => {
    expect(stepIndex(3, 2, 1)).toBe(0)
    expect(stepIndex(3, 0, -1)).toBe(2)
    expect(stepIndex(3, -1, 1)).toBe(0)
    expect(stepIndex(3, -1, -1)).toBe(2)
    expect(stepIndex(0, -1, 1)).toBe(-1)
  })

  it('validates content and file size', () => {
    expect(validateDocContent('short')).toMatch(/at least 20/)
    expect(validateDocContent('x'.repeat(20))).toBeNull()
    expect(validateFileSize(100)).toBeNull()
    expect(validateFileSize(300_000)).toMatch(/300 KB/)
  })
})
