import { describe, expect, it } from 'vitest'
import type { RouteTestResult } from '../src/lib/api-types'
import { confidencePercent, describeRouting, droppedPicks, formatLatency } from '../src/lib/routing-result'

const base: RouteTestResult = {
  mode: 'router',
  selected: [],
  confidence: 0.31,
  threshold: 0.5,
  rationale: 'because',
  raw_picks: [],
  candidates: [
    { slug: 'triage-outage', name: 'Triage outage', description: 'd', selected: false },
    { slug: 'kb-answer', name: 'KB answer', description: 'd', selected: false },
  ],
  latency_ms: 420,
}

describe('describeRouting', () => {
  it('picked uses the skill name', () => {
    const d = describeRouting({ ...base, selected: ['triage-outage'], raw_picks: ['triage-outage'], confidence: 0.9 })
    expect(d.tone).toBe('picked')
    expect(d.headline).toBe('Router picks: Triage outage')
  })
  it('dropped explains the threshold', () => {
    const d = describeRouting({ ...base, raw_picks: ['kb-answer'] })
    expect(d.tone).toBe('dropped')
    expect(d.headline).toContain('0.31 is below the 0.50 threshold')
  })
  it('none when nothing proposed', () => {
    expect(describeRouting(base).tone).toBe('none')
  })
  it('forced for slash', () => {
    const d = describeRouting({ ...base, mode: 'slash', selected: ['kb-answer'], confidence: 1, latency_ms: null })
    expect(d.tone).toBe('forced')
    expect(d.headline).toBe('Forced by slash command /kb-answer')
  })
  it('falls back to slug for unknown candidates', () => {
    expect(describeRouting({ ...base, selected: ['ghost'] }).headline).toBe('Router picks: ghost')
  })
})

describe('helpers', () => {
  it('droppedPicks', () => {
    expect(droppedPicks({ raw_picks: ['a', 'b'], selected: ['a'] })).toEqual(['b'])
  })
  it('confidencePercent clamps', () => {
    expect(confidencePercent(0.314)).toBe(31)
    expect(confidencePercent(2)).toBe(100)
    expect(confidencePercent(-1)).toBe(0)
    expect(confidencePercent(Number.NaN)).toBe(0)
  })
  it('formatLatency', () => {
    expect(formatLatency(420.4)).toBe('420 ms')
    expect(formatLatency(1500)).toBe('1.5 s')
    expect(formatLatency(null)).toBe('no model call')
  })
})
