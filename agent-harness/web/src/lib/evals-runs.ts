/** Pure shaping helpers for the Evals pages: scoring-run list filters/sort and
 * the per-result filters of the run detail. Kept free of React so they can be
 * unit-tested without a DOM. */

import type { EvalResultRow, EvalRunStatus, EvalRunSummary } from './api-types'
import { progressPercent } from './eval-shapes'

export const EVAL_RUN_STATUSES: readonly EvalRunStatus[] = ['queued', 'running', 'completed', 'failed']
export const EVAL_RUN_SORT_COLUMNS = ['created', 'status', 'progress'] as const
export const EVAL_RESULT_SORT_COLUMNS = ['run', 'metric', 'score'] as const

export interface EvalRunFilters {
  q: string
  status: string
}

export function hasEvalRunFilters(filters: EvalRunFilters): boolean {
  return filters.q.trim() !== '' || filters.status !== ''
}

/** Case-insensitive match on id, scope and judge model, plus an exact status. */
export function filterEvalRuns(runs: readonly EvalRunSummary[], filters: EvalRunFilters): EvalRunSummary[] {
  const needle = filters.q.trim().toLowerCase()
  return runs.filter((run) => {
    if (filters.status && run.status !== filters.status) return false
    if (!needle) return true
    return [run.id, run.scope, run.judge_model, run.judge_version].some((field) => field.toLowerCase().includes(needle))
  })
}

export function evalRunSortKey(run: EvalRunSummary, column: string): string | number | null {
  if (column === 'status') return run.status
  if (column === 'progress') return progressPercent(run.done, run.total)
  return run.created_at
}

export type EvalStatusTone = 'ok' | 'danger' | 'iris' | 'neutral'

export function evalStatusTone(status: string): EvalStatusTone {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'iris'
  return 'neutral'
}

export function isEvalRunInFlight(status: string): boolean {
  return status === 'queued' || status === 'running'
}

/** A result counts as failed when the judge said no or produced no score. */
export function isFailedResult(row: EvalResultRow): boolean {
  return row.score === null || row.passed === false
}

export interface EvalResultFilters {
  metric: string
  agent: string
  failedOnly: boolean
}

export function hasEvalResultFilters(filters: EvalResultFilters): boolean {
  return filters.metric !== '' || filters.agent !== '' || filters.failedOnly
}

/** The agent filter value for rows with no agent. */
export const UNASSIGNED_AGENT = '__none__'

export function filterEvalResults(results: readonly EvalResultRow[], filters: EvalResultFilters): EvalResultRow[] {
  return results.filter((row) => {
    if (filters.metric && row.metric !== filters.metric) return false
    if (filters.agent && (row.agent_id ?? UNASSIGNED_AGENT) !== filters.agent) return false
    if (filters.failedOnly && !isFailedResult(row)) return false
    return true
  })
}

/** Distinct, sorted values of one column, for the filter dropdowns. */
export function distinctResultValues(results: readonly EvalResultRow[], pick: (row: EvalResultRow) => string | null): string[] {
  const values = new Set<string>()
  for (const row of results) {
    const value = pick(row)
    if (value) values.add(value)
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}

export function evalResultSortKey(row: EvalResultRow, column: string): string | number | null {
  if (column === 'metric') return row.metric
  if (column === 'score') return row.score
  if (column === 'run') return row.run_id
  return row.created_at
}

export type ResultVerdict = 'unavailable' | 'failed' | 'passed' | 'recorded'

/** Row status: unavailable (no score), failed (judge said no), passed, or just
 * recorded (raw metrics such as latency carry no verdict). */
export function resultVerdict(row: EvalResultRow): ResultVerdict {
  if (row.score === null) return 'unavailable'
  if (row.passed === false) return 'failed'
  if (row.passed === true) return 'passed'
  return 'recorded'
}
