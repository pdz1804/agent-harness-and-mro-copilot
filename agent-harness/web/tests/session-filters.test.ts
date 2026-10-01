import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTER_STATE,
  buildFilters,
  countLabel,
  dayRangeToIso,
  hasActiveFilters,
} from '../src/lib/session-filters'

describe('dayRangeToIso', () => {
  it('uses local day boundaries', () => {
    const { since, until } = dayRangeToIso('2026-03-05', '2026-03-06')
    const s = new Date(since!)
    const u = new Date(until!)
    expect([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes()]).toEqual([2026, 2, 5, 0, 0])
    expect([u.getDate(), u.getHours(), u.getMinutes(), u.getSeconds()]).toEqual([6, 23, 59, 59])
  })
  it('omits empty or invalid values', () => {
    expect(dayRangeToIso('', '')).toEqual({})
    expect(dayRangeToIso('nope', '2026-02-31')).toEqual({})
  })
  it('supports a single bound', () => {
    expect(Object.keys(dayRangeToIso('2026-01-01', ''))).toEqual(['since'])
    expect(Object.keys(dayRangeToIso('', '2026-01-01'))).toEqual(['until'])
  })
})

describe('buildFilters', () => {
  it('omits empty values', () => {
    expect(buildFilters(EMPTY_FILTER_STATE)).toEqual({})
    expect(buildFilters({ ...EMPTY_FILTER_STATE, q: '   ' })).toEqual({})
  })
  it('maps set values', () => {
    const f = buildFilters({
      ...EMPTY_FILTER_STATE,
      q: ' disk ',
      status: 'failed',
      agentId: 'a1',
      archived: 'only',
      fromDate: '2026-03-05',
    })
    expect(f).toMatchObject({ q: 'disk', status: 'failed', agent_id: 'a1', archived: 'only' })
    expect(f.since).toBeDefined()
    expect(f.until).toBeUndefined()
  })
  it('leaves archived out for the default only', () => {
    expect(buildFilters({ ...EMPTY_FILTER_STATE, archived: 'include' }).archived).toBe('include')
    expect('archived' in buildFilters(EMPTY_FILTER_STATE)).toBe(false)
  })
})

describe('hasActiveFilters', () => {
  it('is false for the empty state and whitespace search', () => {
    expect(hasActiveFilters(EMPTY_FILTER_STATE)).toBe(false)
    expect(hasActiveFilters({ ...EMPTY_FILTER_STATE, q: '  ' })).toBe(false)
  })
  it('is true when any filter is set', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTER_STATE, status: 'failed' })).toBe(true)
    expect(hasActiveFilters({ ...EMPTY_FILTER_STATE, archived: 'include' })).toBe(true)
    expect(hasActiveFilters({ ...EMPTY_FILTER_STATE, toDate: '2026-01-01' })).toBe(true)
  })
})

describe('countLabel', () => {
  it('formats counts', () => {
    expect(countLabel(3, 12)).toBe('3 of 12 sessions')
    expect(countLabel(1, 1)).toBe('1 of 1 session')
  })
})
