/** Pure helpers for the agent usage stats (`GET /agents/{id}/stats`). */

export const NOT_SCORED_LABEL = 'not scored yet'

/** Eval success rate as a whole-percent string. `null` (or no scored runs)
 * means the LLM judge has not scored any run for this agent yet. */
export function formatSuccessRate(rate: number | null, scored: number): string {
  if (rate === null || !Number.isFinite(rate) || scored <= 0) return NOT_SCORED_LABEL
  const clamped = Math.min(1, Math.max(0, rate))
  return `${Math.round(clamped * 100)}%`
}

/** Tooltip text explaining what the success rate is computed over. */
export function successRateTitle(scored: number): string {
  return scored > 0
    ? `Judge task_success pass rate over ${scored} scored run${scored === 1 ? '' : 's'}`
    : 'No runs have been scored by the eval judge yet'
}

/** Average steps per run, one decimal; `n/a` when there are no runs. */
export function formatAvgSteps(avg: number | null): string {
  if (avg === null || !Number.isFinite(avg)) return 'n/a'
  return (Math.round(avg * 10) / 10).toFixed(1)
}

export interface StatusShare {
  status: string
  count: number
  /** Fraction of all runs, 0..1. */
  share: number
}

/** Status breakdown sorted by count (desc), then status name. Zero/invalid
 * counts are dropped. */
export function summarizeStatuses(byStatus: Record<string, number>): StatusShare[] {
  const entries = Object.entries(byStatus).filter(([, n]) => Number.isFinite(n) && n > 0)
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  return entries
    .map(([status, count]) => ({ status, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))
}
