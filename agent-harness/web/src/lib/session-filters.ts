import type { ArchivedFilter, SessionFilters } from './api-types'

export interface SessionFilterState {
  q: string
  status: string
  agentId: string
  fromDate: string
  toDate: string
  archived: ArchivedFilter
}

export const EMPTY_FILTER_STATE: SessionFilterState = {
  q: '',
  status: '',
  agentId: '',
  fromDate: '',
  toDate: '',
  archived: 'exclude',
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseLocalDate(value: string): [number, number, number] | null {
  const m = DATE_RE.exec(value)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
  return [y, mo, d]
}

/** Converts `YYYY-MM-DD` date-input values to ISO instants at the local day
 * start (From) and local day end (To). Invalid or empty values are omitted. */
export function dayRangeToIso(fromDate: string, toDate: string): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {}
  const from = parseLocalDate(fromDate)
  const to = parseLocalDate(toDate)
  if (from) out.since = new Date(from[0], from[1] - 1, from[2], 0, 0, 0, 0).toISOString()
  if (to) out.until = new Date(to[0], to[1] - 1, to[2], 23, 59, 59, 999).toISOString()
  return out
}

/** Builds the API filters, omitting every empty value. */
export function buildFilters(state: SessionFilterState): SessionFilters {
  const filters: SessionFilters = {}
  const q = state.q.trim()
  if (q) filters.q = q
  if (state.status) filters.status = state.status
  if (state.agentId) filters.agent_id = state.agentId
  Object.assign(filters, dayRangeToIso(state.fromDate, state.toDate))
  if (state.archived !== 'exclude') filters.archived = state.archived
  return filters
}

export function hasActiveFilters(state: SessionFilterState): boolean {
  return (
    state.q.trim() !== '' ||
    state.status !== '' ||
    state.agentId !== '' ||
    state.fromDate !== '' ||
    state.toDate !== '' ||
    state.archived !== 'exclude'
  )
}

export function countLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'session' : 'sessions'
  return `${shown} of ${total} ${noun}`
}
