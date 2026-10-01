import type { Incident, Service, ServiceStatus } from './api-types'

export const SERVICE_STATUSES: ServiceStatus[] = ['operational', 'degraded', 'down']
export type ServiceStatusFilter = ServiceStatus | 'all'
export const SERVICE_SORT_COLUMNS = ['name', 'status', 'latency', 'error_rate', 'deploy'] as const

const STATUS_RANK: Record<ServiceStatus, number> = { down: 0, degraded: 1, operational: 2 }

export function serviceStatusLabel(status: ServiceStatus): string {
  return status[0].toUpperCase() + status.slice(1)
}

export function formatLatency(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)} ms`
}

/** `0.0412` -> "4.12%". */
export function formatErrorRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(2)}%`
}

export function countServiceStatuses(list: Service[]): Record<ServiceStatusFilter, number> {
  const counts: Record<ServiceStatusFilter, number> = { all: list.length, operational: 0, degraded: 0, down: 0 }
  for (const s of list) if (s.status in counts) counts[s.status] += 1
  return counts
}

export function filterServices(list: Service[], filter: { status: ServiceStatusFilter; query: string }): Service[] {
  const needle = filter.query.trim().toLowerCase()
  return list.filter(
    (s) =>
      (filter.status === 'all' || s.status === filter.status) &&
      (!needle || s.name.toLowerCase().includes(needle) || (s.owner ?? '').toLowerCase().includes(needle)),
  )
}

/** Comparable value per column; status sorts worst-first when ascending. */
export function serviceSortKey(s: Service, column: string): string | number | null {
  switch (column) {
    case 'status':
      return STATUS_RANK[s.status] ?? SERVICE_STATUSES.length
    case 'latency':
      return s.latency_ms
    case 'error_rate':
      return s.error_rate
    case 'deploy': {
      const t = s.last_deploy ? Date.parse(s.last_deploy) : NaN
      return Number.isNaN(t) ? null : t
    }
    default:
      return s.name
  }
}

/** Unresolved incidents per service name (open + acknowledged). */
export function activeIncidentCounts(incidents: Incident[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const i of incidents) {
    if (!i.service_name || i.status === 'resolved') continue
    counts.set(i.service_name, (counts.get(i.service_name) ?? 0) + 1)
  }
  return counts
}
