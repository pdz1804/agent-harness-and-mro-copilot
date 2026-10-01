import type { Integration } from './api-types'

export type EnabledFilter = 'all' | 'enabled' | 'disabled'
export const ENABLED_FILTERS: readonly EnabledFilter[] = ['all', 'enabled', 'disabled']

export interface IntegrationFilters {
  q: string
  state: EnabledFilter
}

export function hasIntegrationFilters(filters: IntegrationFilters): boolean {
  return filters.q.trim() !== '' || filters.state !== 'all'
}

export function filterIntegrations(items: readonly Integration[], filters: IntegrationFilters): Integration[] {
  const needle = filters.q.trim().toLowerCase()
  return items.filter((item) => {
    if (filters.state === 'enabled' && !item.enabled) return false
    if (filters.state === 'disabled' && item.enabled) return false
    return !needle || item.tool_name.toLowerCase().includes(needle)
  })
}

export function hasCustomLimits(item: Pick<Integration, 'timeout_seconds' | 'max_retries'>): boolean {
  return item.timeout_seconds !== null || item.max_retries !== null
}

/** "30 s timeout · 2 retries" for the overridden fields, "Defaults" otherwise. */
export function limitsSummary(item: Pick<Integration, 'timeout_seconds' | 'max_retries'>): string {
  const parts: string[] = []
  if (item.timeout_seconds !== null) parts.push(`${item.timeout_seconds} s timeout`)
  if (item.max_retries !== null) parts.push(`${item.max_retries} ${item.max_retries === 1 ? 'retry' : 'retries'}`)
  return parts.length ? parts.join(' · ') : 'Defaults'
}

export function limitsToText(value: number | null): string {
  return value === null ? '' : String(value)
}

export interface LimitsValue {
  timeout_seconds: number | null
  max_retries: number | null
}

export function sameLimits(a: LimitsValue, b: LimitsValue): boolean {
  return a.timeout_seconds === b.timeout_seconds && a.max_retries === b.max_retries
}

/** "timeout 30 s, retries 2" / "defaults" for a toast title. */
export function describeLimits(value: LimitsValue): string {
  if (value.timeout_seconds === null && value.max_retries === null) return 'default limits'
  const parts: string[] = []
  parts.push(value.timeout_seconds === null ? 'default timeout' : `timeout ${value.timeout_seconds} s`)
  parts.push(value.max_retries === null ? 'default retries' : `retries ${value.max_retries}`)
  return parts.join(', ')
}
