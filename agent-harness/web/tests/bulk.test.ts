import { describe, expect, it } from 'vitest'
import { bulkSummary, pruneSelection, runBulk, toggleId } from '../src/lib/bulk'

describe('runBulk', () => {
  it('reports successes and failures per id, preserving order', async () => {
    const result = await runBulk(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('409 in progress')
      return id
    })
    expect(result.ok).toEqual(['a', 'c'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].id).toBe('b')
    expect((result.failed[0].error as Error).message).toBe('409 in progress')
  })
  it('handles an empty selection', async () => {
    expect(await runBulk([], async () => 1)).toEqual({ ok: [], failed: [] })
  })
})

describe('bulkSummary', () => {
  it('pluralises and mentions failures', () => {
    expect(bulkSummary('Archived', 'session', { ok: ['a'], failed: [] })).toBe('Archived 1 session')
    expect(bulkSummary('Archived', 'session', { ok: ['a', 'b', 'c'], failed: [] })).toBe('Archived 3 sessions')
    expect(bulkSummary('Deleted', 'session', { ok: ['a'], failed: [{ id: 'b', error: null }, { id: 'c', error: null }] })).toBe(
      'Deleted 1 session · 2 failed',
    )
  })
})

describe('selection helpers', () => {
  it('toggles immutably', () => {
    const start = new Set(['a'])
    const added = toggleId(start, 'b', true)
    expect([...added]).toEqual(['a', 'b'])
    expect([...start]).toEqual(['a'])
    expect([...toggleId(added, 'a', false)]).toEqual(['b'])
  })
  it('prunes ids that left the list and keeps identity when nothing changed', () => {
    const sel = new Set(['a', 'b'])
    expect(pruneSelection(sel, ['a', 'b', 'c'])).toBe(sel)
    expect([...pruneSelection(sel, ['b'])]).toEqual(['b'])
  })
})
