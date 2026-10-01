import { describe, expect, it } from 'vitest'
import {
  buildPieData,
  needsSparseTrendFallback,
  paginateRows,
  validateWidgetConfigClient,
} from '../src/lib/widget-shapes'

describe('needsSparseTrendFallback', () => {
  it('falls back for line/area charts with fewer than 2 points', () => {
    expect(needsSparseTrendFallback('line', 0)).toBe(true)
    expect(needsSparseTrendFallback('line', 1)).toBe(true)
    expect(needsSparseTrendFallback('area', 1)).toBe(true)
    expect(needsSparseTrendFallback('line', 2)).toBe(false)
    expect(needsSparseTrendFallback('area', 5)).toBe(false)
  })

  it('never falls back for bar/pie/stat/table, regardless of row count', () => {
    expect(needsSparseTrendFallback('bar', 0)).toBe(false)
    expect(needsSparseTrendFallback('pie', 1)).toBe(false)
    expect(needsSparseTrendFallback('stat', 1)).toBe(false)
    expect(needsSparseTrendFallback('table', 1)).toBe(false)
  })
})

describe('validateWidgetConfigClient', () => {
  it('requires a value column for stat', () => {
    expect(validateWidgetConfigClient('stat', {})).toMatch(/value column/)
    expect(validateWidgetConfigClient('stat', { value_col: 'n' })).toBeNull()
  })

  it('rejects a blank/whitespace-only value column', () => {
    expect(validateWidgetConfigClient('stat', { value_col: '   ' })).toMatch(/value column/)
  })

  it.each(['line', 'bar', 'area'] as const)('requires x_col and at least one y_col for %s', (kind) => {
    expect(validateWidgetConfigClient(kind, {})).toMatch(/X column/)
    expect(validateWidgetConfigClient(kind, { x_col: 'day' })).toMatch(/Y column/)
    expect(validateWidgetConfigClient(kind, { x_col: 'day', y_cols: [] })).toMatch(/Y column/)
    expect(validateWidgetConfigClient(kind, { x_col: 'day', y_cols: ['n'] })).toBeNull()
  })

  it('requires label_col and value_col for pie', () => {
    expect(validateWidgetConfigClient('pie', {})).toMatch(/label column/)
    expect(validateWidgetConfigClient('pie', { label_col: 'l' })).toMatch(/value column/)
    expect(validateWidgetConfigClient('pie', { label_col: 'l', value_col: 'v' })).toBeNull()
  })

  it('allows an empty table config but rejects an out-of-range page_size', () => {
    expect(validateWidgetConfigClient('table', {})).toBeNull()
    expect(validateWidgetConfigClient('table', { page_size: 0 })).toMatch(/Page size/)
    expect(validateWidgetConfigClient('table', { page_size: 501 })).toMatch(/Page size/)
    expect(validateWidgetConfigClient('table', { page_size: 50 })).toBeNull()
  })

  it('requires title_col for list, subtitle/badge are optional', () => {
    expect(validateWidgetConfigClient('list', {})).toMatch(/title column/)
    expect(validateWidgetConfigClient('list', { title_col: 't' })).toBeNull()
  })
})

describe('paginateRows', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ n: i }))

  it('slices the first page by default', () => {
    const { pageRows, totalPages, page } = paginateRows(rows, 20, 0)
    expect(pageRows).toHaveLength(20)
    expect(pageRows[0]).toEqual({ n: 0 })
    expect(totalPages).toBe(3)
    expect(page).toBe(0)
  })

  it('slices the final (partial) page', () => {
    const { pageRows, page } = paginateRows(rows, 20, 2)
    expect(pageRows).toHaveLength(5)
    expect(page).toBe(2)
  })

  it('clamps an out-of-range page index into bounds', () => {
    const { pageRows, page } = paginateRows(rows, 20, 99)
    expect(page).toBe(2)
    expect(pageRows).toHaveLength(5)

    const negative = paginateRows(rows, 20, -5)
    expect(negative.page).toBe(0)
  })

  it('treats a zero/negative page size as 1 row per page rather than dividing by zero', () => {
    const { totalPages } = paginateRows(rows, 0, 0)
    expect(totalPages).toBe(45)
  })

  it('returns a single empty page for an empty result set', () => {
    const { pageRows, totalPages, page } = paginateRows([], 20, 0)
    expect(pageRows).toEqual([])
    expect(totalPages).toBe(1)
    expect(page).toBe(0)
  })
})

describe('buildPieData', () => {
  it('maps label/value columns into recharts-ready slices', () => {
    const rows = [
      { status: 'completed', n: 8 },
      { status: 'failed', n: 2 },
    ]
    expect(buildPieData(rows, 'status', 'n')).toEqual([
      { name: 'completed', value: 8 },
      { name: 'failed', value: 2 },
    ])
  })

  it('coerces a non-numeric value to 0 instead of NaN', () => {
    const rows = [{ status: 'weird', n: 'not-a-number' }]
    expect(buildPieData(rows, 'status', 'n')).toEqual([{ name: 'weird', value: 0 }])
  })

  it('coerces a missing/null label to an empty string', () => {
    const rows = [{ n: 3 }]
    expect(buildPieData(rows, 'status', 'n')).toEqual([{ name: '', value: 3 }])
  })
})
