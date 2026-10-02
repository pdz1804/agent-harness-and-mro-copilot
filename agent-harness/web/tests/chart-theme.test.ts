import { describe, expect, it } from 'vitest'
import { statusColor } from '../src/components/widgets/chart-theme'

describe('statusColor', () => {
  it('colours statuses by meaning', () => {
    expect(statusColor('operational')).toBe(statusColor('resolved'))
    expect(statusColor('down')).toBe(statusColor('critical'))
    expect(statusColor('Degraded')).toBe(statusColor('medium'))
  })

  it('keeps every incident severity distinguishable in one chart', () => {
    const colours = ['critical', 'high', 'medium', 'low'].map(statusColor)
    expect(colours.every(Boolean)).toBe(true)
    expect(new Set(colours).size).toBe(4)
  })

  it('returns null for categories that are not statuses', () => {
    expect(statusColor('payments-api')).toBeNull()
  })
})
