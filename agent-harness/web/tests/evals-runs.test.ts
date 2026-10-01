import { describe, expect, it } from 'vitest'
import type { EvalResultRow, EvalRunSummary } from '../src/lib/api-types'
import {
  UNASSIGNED_AGENT,
  distinctResultValues,
  evalRunSortKey,
  evalStatusTone,
  filterEvalResults,
  filterEvalRuns,
  hasEvalResultFilters,
  hasEvalRunFilters,
  isEvalRunInFlight,
  isFailedResult,
  resultVerdict,
} from '../src/lib/evals-runs'

const run = (over: Partial<EvalRunSummary>): EvalRunSummary => ({
  id: 'evr-1',
  triggered_by: 'u1',
  scope: 'mine',
  judge_version: 'v1',
  judge_model: 'gpt-4o-mini',
  status: 'completed',
  total: 10,
  done: 10,
  started_at: null,
  finished_at: null,
  summary: null,
  mlflow_run_id: null,
  mlflow_url: null,
  error: null,
  created_at: '2026-10-01T10:00:00Z',
  ...over,
})

const result = (over: Partial<EvalResultRow>): EvalResultRow => ({
  id: 'r1',
  eval_run_id: 'evr-1',
  run_id: 'run-1',
  session_id: null,
  agent_id: 'agent-a',
  metric: 'task_success',
  score: 1,
  passed: true,
  rationale: null,
  judge_version: 'v1',
  created_at: '2026-10-01T10:00:00Z',
  ...over,
})

describe('filterEvalRuns', () => {
  const runs = [run({ id: 'evr-1' }), run({ id: 'evr-2', status: 'failed', judge_model: 'claude' })]
  it('filters by status and search', () => {
    expect(filterEvalRuns(runs, { q: '', status: 'failed' }).map((r) => r.id)).toEqual(['evr-2'])
    expect(filterEvalRuns(runs, { q: 'CLAUDE', status: '' }).map((r) => r.id)).toEqual(['evr-2'])
    expect(filterEvalRuns(runs, { q: '', status: '' })).toHaveLength(2)
  })
  it('reports active filters', () => {
    expect(hasEvalRunFilters({ q: ' ', status: '' })).toBe(false)
    expect(hasEvalRunFilters({ q: 'x', status: '' })).toBe(true)
  })
})

describe('run helpers', () => {
  it('maps status to tone and in-flight', () => {
    expect(evalStatusTone('completed')).toBe('ok')
    expect(evalStatusTone('queued')).toBe('neutral')
    expect(isEvalRunInFlight('running')).toBe(true)
    expect(isEvalRunInFlight('failed')).toBe(false)
  })
  it('computes progress sort key', () => {
    expect(evalRunSortKey(run({ done: 5, total: 10 }), 'progress')).toBe(50)
  })
})

describe('filterEvalResults', () => {
  const rows = [
    result({ id: 'a' }),
    result({ id: 'b', metric: 'safety', passed: false, score: 0.2 }),
    result({ id: 'c', agent_id: null, score: null, passed: null }),
  ]
  it('filters by metric, agent and failed-only', () => {
    expect(filterEvalResults(rows, { metric: 'safety', agent: '', failedOnly: false }).map((r) => r.id)).toEqual(['b'])
    expect(filterEvalResults(rows, { metric: '', agent: UNASSIGNED_AGENT, failedOnly: false }).map((r) => r.id)).toEqual(['c'])
    expect(filterEvalResults(rows, { metric: '', agent: '', failedOnly: true }).map((r) => r.id)).toEqual(['b', 'c'])
  })
  it('detects failures and verdicts', () => {
    expect(isFailedResult(rows[2])).toBe(true)
    expect(resultVerdict(rows[0])).toBe('passed')
    expect(resultVerdict(rows[1])).toBe('failed')
    expect(resultVerdict(rows[2])).toBe('unavailable')
    expect(resultVerdict(result({ passed: null }))).toBe('recorded')
  })
  it('lists distinct values sorted', () => {
    expect(distinctResultValues(rows, (r) => r.metric)).toEqual(['safety', 'task_success'])
    expect(distinctResultValues(rows, (r) => r.agent_id)).toEqual(['agent-a'])
  })
  it('reports active filters', () => {
    expect(hasEvalResultFilters({ metric: '', agent: '', failedOnly: false })).toBe(false)
    expect(hasEvalResultFilters({ metric: '', agent: '', failedOnly: true })).toBe(true)
  })
})
