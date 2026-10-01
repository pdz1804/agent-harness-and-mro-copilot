import { describe, expect, it } from 'vitest'
import { formatAvgSteps, formatSuccessRate, successRateTitle, summarizeStatuses } from '../src/lib/agent-usage'

describe('formatSuccessRate', () => {
  it('rounds to whole percent', () => {
    expect(formatSuccessRate(0.8333, 6)).toBe('83%')
    expect(formatSuccessRate(1, 2)).toBe('100%')
    expect(formatSuccessRate(0, 3)).toBe('0%')
  })
  it('says not scored when null or nothing scored', () => {
    expect(formatSuccessRate(null, 0)).toBe('not scored yet')
    expect(formatSuccessRate(0.5, 0)).toBe('not scored yet')
  })
  it('clamps out-of-range values', () => {
    expect(formatSuccessRate(1.4, 1)).toBe('100%')
    expect(formatSuccessRate(Number.NaN, 1)).toBe('not scored yet')
  })
  it('titles pluralise', () => {
    expect(successRateTitle(1)).toContain('1 scored run')
    expect(successRateTitle(1)).not.toContain('runs')
    expect(successRateTitle(4)).toContain('4 scored runs')
    expect(successRateTitle(0)).toContain('No runs')
  })
})

describe('formatAvgSteps', () => {
  it('formats one decimal or n/a', () => {
    expect(formatAvgSteps(3.456)).toBe('3.5')
    expect(formatAvgSteps(null)).toBe('n/a')
  })
})

describe('summarizeStatuses', () => {
  it('sorts by count then name with shares', () => {
    const out = summarizeStatuses({ failed: 1, completed: 6, cancelled: 1 })
    expect(out.map((s) => s.status)).toEqual(['completed', 'cancelled', 'failed'])
    expect(out[0].share).toBeCloseTo(0.75)
  })
  it('drops zero counts and handles empty', () => {
    expect(summarizeStatuses({ completed: 0 })).toEqual([])
    expect(summarizeStatuses({})).toEqual([])
  })
})
