/** Pure helpers for the dashboards pages: list scope + search, create-flow
 * validation and widget reordering. */

import type { Dashboard } from './api-types'

export type DashboardScope = 'all' | 'mine' | 'shared'
export const DASHBOARD_SCOPES: readonly DashboardScope[] = ['all', 'mine', 'shared']

/** Scope tab + case-insensitive search over name, description and template. */
export function filterDashboards(dashboards: Dashboard[], query: string, scope: DashboardScope, currentUserId: string): Dashboard[] {
  const needle = query.trim().toLowerCase()
  return dashboards.filter((d) => {
    if (scope === 'mine' && d.owner_id !== currentUserId) return false
    if (scope === 'shared' && d.visibility !== 'shared') return false
    if (!needle) return true
    return `${d.name} ${d.description} ${d.template_key}`.toLowerCase().includes(needle)
  })
}

export function validateDashboardName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Give the dashboard a name.'
  if (trimmed.length > 120) return 'Keep the name under 120 characters.'
  return null
}

/** The ids after moving `id` by `delta` places; unchanged when it would leave the list. */
export function moveId(ids: string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const next = [...ids]
  const moved = next[from]
  next[from] = next[to]
  next[to] = moved
  return next
}
