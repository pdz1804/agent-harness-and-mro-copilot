import { describe, expect, it } from 'vitest'
import type { Dashboard } from '../src/lib/api-types'
import { filterDashboards, moveId, validateDashboardName } from '../src/lib/dashboards-model'

const base = { description: '', template_key: 'blank', layout_cols: 12, last_refreshed_at: null, created_at: '', updated_at: '', widgets: [] }
const dashboards: Dashboard[] = [
  { ...base, id: 'd1', name: 'Incidents by severity', owner_id: 'alice', visibility: 'private' },
  { ...base, id: 'd2', name: 'Ops overview', owner_id: 'bob', visibility: 'shared' },
]

describe('filterDashboards', () => {
  it('scopes by owner and visibility', () => {
    expect(filterDashboards(dashboards, '', 'mine', 'alice').map((d) => d.id)).toEqual(['d1'])
    expect(filterDashboards(dashboards, '', 'shared', 'alice').map((d) => d.id)).toEqual(['d2'])
    expect(filterDashboards(dashboards, '', 'all', 'alice')).toHaveLength(2)
  })
  it('searches the name', () => {
    expect(filterDashboards(dashboards, 'OVERVIEW', 'all', 'alice').map((d) => d.id)).toEqual(['d2'])
  })
})

describe('validateDashboardName', () => {
  it('rejects blank and overlong names', () => {
    expect(validateDashboardName('  ')).toBeTruthy()
    expect(validateDashboardName('x'.repeat(121))).toBeTruthy()
    expect(validateDashboardName('Fleet')).toBeNull()
  })
})

describe('moveId', () => {
  it('swaps neighbours and clamps at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b'], 'zz', 1)).toEqual(['a', 'b'])
  })
})
