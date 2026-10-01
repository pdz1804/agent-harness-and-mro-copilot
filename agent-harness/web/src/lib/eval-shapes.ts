/** Pure result-shaping helpers for the Evals tab (phase 07), factored out
 * of `components/evals/*` so they're unit-testable in plain `vitest`
 * without a DOM — mirrors `widget-shapes.ts`'s existing pattern. */

import type { EvalMetricOverviewRow, EvalSeriesPoint } from './api-types'

// Metrics whose "score" is a raw value (ms/tokens/count), not a 0..1
// rubric mean — shown as a plain number, never a percentage.
export const RAW_VALUE_METRICS = new Set([
  'latency_ms',
  'agent_latency_ms',
  'total_tokens',
  'steps',
  'tool_errors',
])

// `agent_harness.eval.metrics.deterministic_metrics` exposes two durations:
// `latency_ms` (wall-clock, first-to-last trace event, including any human
// approval wait) and `agent_latency_ms` (wall-clock minus every
// approval_requested -> approval_granted/denied span — pure agent/LLM/tool
// time). They're equal when a run never hit an approval gate.
export const METRIC_LABELS: Record<string, string> = {
  task_success: 'Task success',
  groundedness: 'Groundedness',
  tool_choice: 'Tool choice',
  tool_use_correctness: 'Tool use correctness',
  safety: 'Safety',
  routing_fit: 'Routing fit',
  latency_ms: 'Latency (wall-clock, ms)',
  agent_latency_ms: 'Latency (agent-only, ms)',
  total_tokens: 'Total tokens',
  steps: 'Steps',
  tool_errors: 'Tool errors',
}

export const METRIC_TOOLTIPS: Record<string, string> = {
  latency_ms:
    'Wall-clock time from first to last trace event, including any time a run spent waiting on human ' +
    'approval. Compare against "Latency (agent-only, ms)" to see how much of that was human wait time.',
  agent_latency_ms:
    'Wall-clock latency minus every approval_requested -> approval_granted/denied span — only the time ' +
    'the agent itself (LLM calls + tool execution) was active. Equal to wall-clock latency when the run ' +
    'never hit an approval gate.',
}

/** Format one metric's value for display: raw metrics as a plain number,
 * everything else as a rounded percentage. `null` (honest "no data"/
 * "judge unavailable") renders as an em dash, never a fabricated 0%. */
export function formatMetricValue(metric: string, value: number | null): string {
  if (value === null) return '—'
  if (RAW_VALUE_METRICS.has(metric)) return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return `${Math.round(value * 100)}%`
}

/** A metric's delta is "good" when it moved toward the desirable
 * direction: up for a 0..1 quality rubric, down for a raw cost/error
 * metric (latency/tokens/steps/tool_errors). `null` (no prior period to
 * compare against) is neither good nor bad. */
export function isDeltaGood(metric: string, delta: number | null): boolean | null {
  if (delta === null) return null
  return RAW_VALUE_METRICS.has(metric) ? delta <= 0 : delta >= 0
}

/** Pivot a flat `(date, metric, mean, n)[]` series into one row per date
 * with each metric as its own column (`{date, [metric]: mean, ...}`) —
 * the shape `recharts`' `LineChart` expects for a multi-series chart. */
export function pivotSeriesByDate(series: EvalSeriesPoint[]): Array<Record<string, string | number>> {
  const dates = Array.from(new Set(series.map((p) => p.date))).sort()
  return dates.map((date) => {
    const row: Record<string, string | number> = { date }
    for (const p of series) {
      if (p.date === date) row[p.metric] = p.mean
    }
    return row
  })
}

/** Distinct metric names present in a series, sorted for stable UI order
 * (toggle chips, legend). */
export function distinctMetrics(series: EvalSeriesPoint[]): string[] {
  return Array.from(new Set(series.map((p) => p.metric))).sort()
}

/** Progress percentage for a scoring-run progress bar; a `total` of 0
 * (nothing left to score, e.g. every run already scored under the current
 * judge_version) renders as fully complete rather than 0/0 -> NaN. */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** Sort metric overview rows so the lowest-scoring rubric metrics surface
 * first (the ones most worth a reviewer's attention), with raw-value
 * metrics (no inherent "good/bad" direction to rank by) kept after them in
 * their original order. */
export function sortMetricsForAttention(rows: EvalMetricOverviewRow[]): EvalMetricOverviewRow[] {
  const rubric = rows.filter((r) => !RAW_VALUE_METRICS.has(r.metric) && r.latest_mean !== null)
  const rest = rows.filter((r) => RAW_VALUE_METRICS.has(r.metric) || r.latest_mean === null)
  rubric.sort((a, b) => (a.latest_mean ?? 0) - (b.latest_mean ?? 0))
  return [...rubric, ...rest]
}
