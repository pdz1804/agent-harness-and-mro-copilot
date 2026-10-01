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
 * resolved. Resolved offers no forward action (Undo of a resolve reopens it). */
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

export const SEVERITIES: IncidentSeverity[] = ['critical', 'high', 'medium', 'low']

export interface IncidentFilter {
  status: StatusFilter
  service: string | null
  /** Exact severity, or empty for any. */
  severity?: string | null
  /** Case-insensitive match on id, title, description and service. */
  query?: string
}

export function matchesQuery(incident: Incident, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [incident.id, incident.title, incident.description, incident.service_name ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  )
}

export function filterIncidents(list: Incident[], filter: IncidentFilter): Incident[] {
  return list.filter(
    (incident) =>
      (filter.status === 'all' || incident.status === filter.status) &&
      (!filter.service || incident.service_name === filter.service) &&
      (!filter.severity || incident.severity === filter.severity) &&
      (!filter.query || matchesQuery(incident, filter.query)),
  )
}

/** Sortable list columns (`?sort=severity:desc`). */
export const INCIDENT_SORT_COLUMNS = ['title', 'severity', 'status', 'service', 'opened'] as const

/** The comparable value for one column; status sorts by lifecycle order. */
export function incidentSortKey(incident: Incident, column: string): string | number | null {
  switch (column) {
    case 'title':
      return incident.title
    case 'severity':
      return severityRank(incident.severity)
    case 'status': {
      const index = (STATUS_ORDER as string[]).indexOf(incident.status)
      return index < 0 ? STATUS_ORDER.length : index
    }
    case 'service':
      return incident.service_name
    default: {
      const t = Date.parse(incident.created_at)
      return Number.isNaN(t) ? null : t
    }
  }
}

/** What the UI shows the instant an acknowledge is clicked, before the
 * deferred request is sent. */
export function acknowledgePatch(now: Date, userId: string | null): Partial<Incident> {
  return { status: 'acknowledged', acknowledged_at: now.toISOString(), acknowledged_by: userId }
}

/** Overlay an optimistic patch on a server row (identity when there is none). */
export function withPatch<T extends Incident>(incident: T, patch: Partial<Incident> | undefined): T {
  return patch ? { ...incident, ...patch } : incident
}

/** Display label for a timeline event (the API also emits "reopened"). */
export function timelineEventLabel(event: string): string {
  const labels: Record<string, string> = { opened: 'Opened', acknowledged: 'Acknowledged', resolved: 'Resolved', reopened: 'Reopened' }
  return labels[event] ?? event
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

export const NOTE_MAX = 1000

/** Inline validation for the resolution note (optional, capped by the API). */
export function resolutionNoteError(note: string): string | null {
  return note.trim().length > NOTE_MAX ? `Keep the note under ${NOTE_MAX} characters (now ${note.trim().length}).` : null
}
