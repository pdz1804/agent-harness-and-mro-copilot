import type { Incident, IncidentSeverity, IncidentStatus } from './api-types'

export type IncidentAction = 'acknowledge' | 'resolve'
export type StatusFilter = IncidentStatus | 'all'

export const STATUS_ORDER: IncidentStatus[] = ['open', 'acknowledged', 'resolved']

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** Lifecycle: open -> acknowledged -> resolved; open may skip straight to
 * resolved; resolved is terminal (no reopening). */
export function nextActions(status: string, canMutate: boolean): IncidentAction[] {
  if (!canMutate) return []
  if (status === 'open') return ['acknowledge', 'resolve']
  if (status === 'acknowledged') return ['resolve']
  return []
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as IncidentStatus] ?? status
}

/** Higher = more severe; unknown severities sort lowest. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as IncidentSeverity] ?? -1
}

export function countByStatus(list: Incident[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { all: list.length, open: 0, acknowledged: 0, resolved: 0 }
  for (const incident of list) {
    if ((STATUS_ORDER as string[]).includes(incident.status)) counts[incident.status as IncidentStatus] += 1
  }
  return counts
}

export function distinctServices(list: Incident[]): string[] {
  const names = new Set<string>()
  for (const incident of list) if (incident.service_name) names.add(incident.service_name)
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function filterIncidents(
  list: Incident[],
  filter: { status: StatusFilter; service: string | null },
): Incident[] {
  return list.filter(
    (incident) =>
      (filter.status === 'all' || incident.status === filter.status) &&
      (!filter.service || incident.service_name === filter.service),
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function formatMs(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  return h ? `${d}d ${h}h` : `${d}d`
}

/** Human span between two ISO timestamps ("12m", "3h 20m", "2d 4h"); '' when unparseable. */
export function durationBetween(isoA: string, isoB: string): string {
  const a = Date.parse(isoA)
  const b = Date.parse(isoB)
  if (Number.isNaN(a) || Number.isNaN(b)) return ''
  return formatMs(Math.abs(b - a))
}

/** "3h ago" style age; '' when unparseable. Future timestamps read "just now". */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = now - t
  if (diff < MINUTE) return 'just now'
  return `${formatMs(diff)} ago`
}
