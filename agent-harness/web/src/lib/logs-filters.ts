import type { Incident, RunStatus, RunSummary } from './api-types'

export const LOG_STATUSES: readonly RunStatus[] = [
  'running',
  'pending_approval',
  'completed',
  'failed',
  'cancelled',
  'guardrail_blocked',
  'step_limit_exceeded',
  'time_limit_exceeded',
  'llm_error_exceeded',
]

export const LOG_SORT_COLUMNS = ['objective', 'status', 'started'] as const

export type IncidentFilter = 'all' | 'yes' | 'no'

export interface LogFilters {
  q: string
  status: string
  incident: IncidentFilter
  from: string
  to: string
}

export function hasLogFilters(filters: LogFilters): boolean {
  return filters.q.trim() !== '' || filters.status !== '' || filters.incident !== 'all' || filters.from !== '' || filters.to !== ''
}

/** `YYYY-MM-DD` of a unix-seconds instant in the viewer's local time, the
 * same frame the date inputs use. */
export function localDay(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Run ids that have at least one incident opened from them. */
export function runIdsWithIncident(incidents: readonly Incident[]): Set<string> {
  const ids = new Set<string>()
  for (const incident of incidents) if (incident.run_id) ids.add(incident.run_id)
  return ids
}

/** Audit-log filter: status, has-incident, an inclusive local date range and a
 * case-insensitive search over objective, run id and session id. */
export function filterLogRuns(runs: readonly RunSummary[], filters: LogFilters, withIncident: ReadonlySet<string>): RunSummary[] {
  const needle = filters.q.trim().toLowerCase()
  return runs.filter((run) => {
    if (filters.status && run.status !== filters.status) return false
    const hasIncident = withIncident.has(run.run_id)
    if (filters.incident === 'yes' && !hasIncident) return false
    if (filters.incident === 'no' && hasIncident) return false
    const day = localDay(run.started_at)
    if (filters.from && day < filters.from) return false
    if (filters.to && day > filters.to) return false
    if (!needle) return true
    return [run.objective, run.run_id, run.session_id ?? ''].some((field) => field.toLowerCase().includes(needle))
  })
}

export function logSortKey(run: RunSummary, column: string): string | number {
  if (column === 'objective') return run.objective
  if (column === 'status') return run.status
  return run.started_at
}
