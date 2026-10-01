import { describe, expect, it } from 'vitest'
import { formatSort, nextSort, parseSort, sortRows } from '../src/lib/table-sort'

describe('nextSort', () => {
  it('starts a new column ascending and flips the same column', () => {
    expect(nextSort(null, 'title')).toEqual({ column: 'title', dir: 'asc' })
    expect(nextSort({ column: 'title', dir: 'asc' }, 'title')).toEqual({ column: 'title', dir: 'desc' })
    expect(nextSort({ column: 'title', dir: 'desc' }, 'title')).toEqual({ column: 'title', dir: 'asc' })
    expect(nextSort({ column: 'title', dir: 'desc' }, 'status')).toEqual({ column: 'status', dir: 'asc' })
  })
})

describe('parseSort / formatSort', () => {
  const allowed = ['title', 'status'] as const
  it('round-trips through the URL form', () => {
    expect(parseSort(formatSort({ column: 'status', dir: 'desc' }), allowed)).toEqual({ column: 'status', dir: 'desc' })
    expect(formatSort(null)).toBe('')
  })
  it('rejects unknown columns and malformed values', () => {
    expect(parseSort('', allowed)).toBeNull()
    expect(parseSort('owner:asc', allowed)).toBeNull()
    expect(parseSort('title:sideways', allowed)).toBeNull()
    expect(parseSort('title', allowed)).toBeNull()
  })
})

describe('sortRows', () => {
  const rows = [
    { id: 'a', name: 'run 10', n: 3 },
    { id: 'b', name: 'Run 2', n: null },
    { id: 'c', name: 'alpha', n: 1 },
    { id: 'd', name: '', n: 2 },
  ]
  const key = (r: (typeof rows)[number], c: string) => (c === 'name' ? r.name : r.n)

  it('returns a copy in original order when unsorted', () => {
    const out = sortRows(rows, null, key)
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })
  it('sorts strings case-insensitively with numeric awareness, missing last', () => {
    expect(sortRows(rows, { column: 'name', dir: 'asc' }, key).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(sortRows(rows, { column: 'name', dir: 'desc' }, key).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('sorts numbers and keeps missing values last in both directions', () => {
    expect(sortRows(rows, { column: 'n', dir: 'asc' }, key).map((r) => r.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(sortRows(rows, { column: 'n', dir: 'desc' }, key).map((r) => r.id)).toEqual(['a', 'd', 'c', 'b'])
  })
})
