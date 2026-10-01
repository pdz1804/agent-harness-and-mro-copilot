import { describe, expect, it } from 'vitest'
import type { Integration } from '../src/lib/api-types'
import { describeLimits, filterIntegrations, hasCustomLimits, hasIntegrationFilters, limitsSummary, limitsToText, sameLimits } from '../src/lib/integrations-filter'

const tool = (over: Partial<Integration>): Integration => ({
  tool_name: 'get_service_status',
  enabled: true,
  updated_at: '2026-10-01T00:00:00Z',
  timeout_seconds: null,
  max_retries: null,
  ...over,
})

describe('filterIntegrations', () => {
  const items = [tool({}), tool({ tool_name: 'create_incident', enabled: false })]
  it('filters by name and enabled state', () => {
    expect(filterIntegrations(items, { q: 'INCIDENT', state: 'all' }).map((i) => i.tool_name)).toEqual(['create_incident'])
    expect(filterIntegrations(items, { q: '', state: 'enabled' }).map((i) => i.tool_name)).toEqual(['get_service_status'])
    expect(filterIntegrations(items, { q: '', state: 'disabled' })).toHaveLength(1)
  })
  it('detects active filters', () => {
    expect(hasIntegrationFilters({ q: '', state: 'all' })).toBe(false)
    expect(hasIntegrationFilters({ q: '', state: 'disabled' })).toBe(true)
  })
})

describe('limit helpers', () => {
  it('summarises overrides', () => {
    expect(limitsSummary(tool({}))).toBe('Defaults')
    expect(limitsSummary(tool({ timeout_seconds: 30, max_retries: 1 }))).toBe('30 s timeout · 1 retry')
    expect(limitsSummary(tool({ max_retries: 3 }))).toBe('3 retries')
    expect(hasCustomLimits(tool({ max_retries: 0 }))).toBe(true)
    expect(hasCustomLimits(tool({}))).toBe(false)
  })
  it('compares and describes limit pairs', () => {
    expect(sameLimits({ timeout_seconds: 1, max_retries: null }, { timeout_seconds: 1, max_retries: null })).toBe(true)
    expect(sameLimits({ timeout_seconds: 1, max_retries: null }, { timeout_seconds: 2, max_retries: null })).toBe(false)
    expect(describeLimits({ timeout_seconds: null, max_retries: null })).toBe('default limits')
    expect(describeLimits({ timeout_seconds: 30, max_retries: null })).toBe('timeout 30 s, default retries')
    expect(limitsToText(null)).toBe('')
    expect(limitsToText(2.5)).toBe('2.5')
  })
})
