import { describe, expect, it } from 'vitest'
import type { Incident, Service } from '../src/lib/api-types'
import {
  activeIncidentCounts,
  countServiceStatuses,
  filterServices,
  formatErrorRate,
  formatLatency,
  serviceSortKey,
  serviceStatusLabel,
} from '../src/lib/services-state'

function svc(over: Partial<Service>): Service {
  return { name: 'api', status: 'operational', latency_ms: 100, error_rate: 0.01, last_deploy: null, owner: 'team-a', last_checked: null, ...over }
}

const list = [
  svc({ name: 'payments-api', status: 'degraded', owner: 'team-pay' }),
  svc({ name: 'search-index', status: 'down', latency_ms: null }),
  svc({ name: 'auth', status: 'operational', last_deploy: '2026-10-01T00:00:00Z' }),
]

describe('formatting', () => {
  it('formats latency and error rate with placeholders', () => {
    expect(formatLatency(812.4)).toBe('812 ms')
    expect(formatLatency(null)).toBe('—')
    expect(formatErrorRate(0.0412)).toBe('4.12%')
    expect(formatErrorRate(null)).toBe('—')
    expect(serviceStatusLabel('degraded')).toBe('Degraded')
  })
})

describe('list helpers', () => {
  it('counts statuses', () => {
    expect(countServiceStatuses(list)).toEqual({ all: 3, operational: 1, degraded: 1, down: 1 })
  })
  it('filters by status and by name or owner', () => {
    expect(filterServices(list, { status: 'down', query: '' }).map((s) => s.name)).toEqual(['search-index'])
    expect(filterServices(list, { status: 'all', query: 'PAY' }).map((s) => s.name)).toEqual(['payments-api'])
    expect(filterServices(list, { status: 'all', query: 'zzz' })).toEqual([])
  })
  it('derives sort keys', () => {
    expect(serviceSortKey(list[1], 'status')).toBeLessThan(serviceSortKey(list[2], 'status') as number)
    expect(serviceSortKey(list[1], 'latency')).toBeNull()
    expect(serviceSortKey(list[2], 'deploy')).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(serviceSortKey(list[0], 'deploy')).toBeNull()
    expect(serviceSortKey(list[0], 'name')).toBe('payments-api')
  })
})

describe('activeIncidentCounts', () => {
  it('counts unresolved incidents per service', () => {
    const base = { title: 't', description: '', severity: 'low', created_at: '', run_id: null, created_by: null, acknowledged_by: null, acknowledged_at: null, resolved_by: null, resolved_at: null, resolution_note: null } as const
    const incidents: Incident[] = [
      { ...base, id: '1', status: 'open', service_name: 'auth' },
      { ...base, id: '2', status: 'acknowledged', service_name: 'auth' },
      { ...base, id: '3', status: 'resolved', service_name: 'auth' },
      { ...base, id: '4', status: 'open', service_name: null },
    ]
    expect(activeIncidentCounts(incidents).get('auth')).toBe(2)
    expect(activeIncidentCounts(incidents).size).toBe(1)
  })
})
