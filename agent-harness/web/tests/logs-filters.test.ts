import { describe, expect, it } from 'vitest'
import type { Incident, RunSummary } from '../src/lib/api-types'
import { filterLogRuns, hasLogFilters, localDay, logSortKey, runIdsWithIncident, type LogFilters } from '../src/lib/logs-filters'

const NONE: LogFilters = { q: '', status: '', incident: 'all', from: '', to: '' }

const run = (over: Partial<RunSummary>): RunSummary => ({
  run_id: 'run-1',
  objective: 'Investigate payments latency',
  status: 'completed',
  started_at: Math.floor(new Date(2026, 9, 1, 12, 0, 0).getTime() / 1000),
  session_id: 'sess-1',
  prompt_version_id: null,
  triggered_by_automation_id: null,
  owner_id: 'u1',
  agent_id: null,
  skill_ids: [],
  ...over,
})

describe('log filters', () => {
  const runs = [run({}), run({ run_id: 'run-2', status: 'failed', objective: 'Wipe the database', session_id: null, started_at: Math.floor(new Date(2026, 9, 3, 9, 0, 0).getTime() / 1000) })]
  const incidents = [{ run_id: 'run-2' } as Incident, { run_id: null } as Incident]
  const withIncident = runIdsWithIncident(incidents)

  it('collects run ids that have incidents', () => {
    expect([...withIncident]).toEqual(['run-2'])
  })
  it('filters by status, incident and search', () => {
    expect(filterLogRuns(runs, { ...NONE, status: 'failed' }, withIncident).map((r) => r.run_id)).toEqual(['run-2'])
    expect(filterLogRuns(runs, { ...NONE, incident: 'no' }, withIncident).map((r) => r.run_id)).toEqual(['run-1'])
    expect(filterLogRuns(runs, { ...NONE, incident: 'yes' }, withIncident).map((r) => r.run_id)).toEqual(['run-2'])
    expect(filterLogRuns(runs, { ...NONE, q: 'WIPE' }, withIncident).map((r) => r.run_id)).toEqual(['run-2'])
    expect(filterLogRuns(runs, { ...NONE, q: 'sess-1' }, withIncident).map((r) => r.run_id)).toEqual(['run-1'])
  })
  it('filters by inclusive local date range', () => {
    expect(localDay(runs[0].started_at)).toBe('2026-10-01')
    expect(filterLogRuns(runs, { ...NONE, from: '2026-10-02' }, withIncident).map((r) => r.run_id)).toEqual(['run-2'])
    expect(filterLogRuns(runs, { ...NONE, to: '2026-10-01' }, withIncident).map((r) => r.run_id)).toEqual(['run-1'])
    expect(filterLogRuns(runs, { ...NONE, from: '2026-10-01', to: '2026-10-03' }, withIncident)).toHaveLength(2)
  })
  it('detects active filters and sort keys', () => {
    expect(hasLogFilters(NONE)).toBe(false)
    expect(hasLogFilters({ ...NONE, incident: 'yes' })).toBe(true)
    expect(logSortKey(runs[0], 'started')).toBe(runs[0].started_at)
    expect(logSortKey(runs[0], 'status')).toBe('completed')
  })
})
