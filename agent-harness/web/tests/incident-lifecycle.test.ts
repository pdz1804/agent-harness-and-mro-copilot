import { describe, expect, it } from 'vitest'
import type { Incident } from '../src/lib/api-types'
import {
  countByStatus,
  distinctServices,
  durationBetween,
  filterIncidents,
  nextActions,
  relativeAge,
  severityRank,
  statusLabel,
} from '../src/lib/incident-lifecycle'

function inc(over: Partial<Incident>): Incident {
  return {
    id: 'inc_1',
    title: 't',
    description: 'd',
    severity: 'low',
    status: 'open',
    created_at: '2026-10-01T00:00:00Z',
    run_id: null,
    service_name: null,
    created_by: null,
    acknowledged_by: null,
    acknowledged_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    ...over,
  }
}

describe('nextActions', () => {
  it('open allows acknowledge and resolve', () => {
    expect(nextActions('open', true)).toEqual(['acknowledge', 'resolve'])
  })
  it('acknowledged only resolves; resolved is terminal', () => {
    expect(nextActions('acknowledged', true)).toEqual(['resolve'])
    expect(nextActions('resolved', true)).toEqual([])
  })
  it('viewers get nothing', () => {
    expect(nextActions('open', false)).toEqual([])
  })
})

describe('labels and ranks', () => {
  it('labels statuses and passes unknown through', () => {
    expect(statusLabel('acknowledged')).toBe('Acknowledged')
    expect(statusLabel('weird')).toBe('weird')
  })
  it('ranks severity', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('high'))
    expect(severityRank('nope')).toBe(-1)
  })
})

describe('list helpers', () => {
  const list = [
    inc({ id: 'a', status: 'open', service_name: 'billing' }),
    inc({ id: 'b', status: 'resolved', service_name: 'auth' }),
    inc({ id: 'c', status: 'open', service_name: 'auth' }),
    inc({ id: 'd', status: 'acknowledged', service_name: null }),
  ]
  it('counts by status', () => {
    expect(countByStatus(list)).toEqual({ all: 4, open: 2, acknowledged: 1, resolved: 1 })
  })
  it('lists distinct sorted services, skipping null', () => {
    expect(distinctServices(list)).toEqual(['auth', 'billing'])
  })
  it('filters by status and service', () => {
    expect(filterIncidents(list, { status: 'open', service: 'auth' }).map((i) => i.id)).toEqual(['c'])
    expect(filterIncidents(list, { status: 'all', service: null })).toHaveLength(4)
  })
})

describe('durations', () => {
  it('formats spans', () => {
    expect(durationBetween('2026-10-01T00:00:00Z', '2026-10-01T00:12:30Z')).toBe('12m')
    expect(durationBetween('2026-10-01T00:00:00Z', '2026-10-01T03:20:00Z')).toBe('3h 20m')
    expect(durationBetween('2026-10-01T00:00:00Z', '2026-10-03T04:00:00Z')).toBe('2d 4h')
    expect(durationBetween('2026-10-01T00:00:00Z', '2026-10-01T00:00:10Z')).toBe('<1m')
    expect(durationBetween('bad', '2026-10-01T00:00:10Z')).toBe('')
  })
  it('formats relative age', () => {
    const now = Date.parse('2026-10-01T03:00:00Z')
    expect(relativeAge('2026-10-01T00:00:00Z', now)).toBe('3h ago')
    expect(relativeAge('2026-10-01T02:59:50Z', now)).toBe('just now')
    expect(relativeAge('nope', now)).toBe('')
  })
})
