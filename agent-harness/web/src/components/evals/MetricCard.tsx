import { ArrowDownRight, ArrowUpRight } from '@phosphor-icons/react'
import { METRIC_LABELS, METRIC_TOOLTIPS, formatMetricValue, isDeltaGood } from '../../lib/eval-shapes'
import type { EvalMetricOverviewRow } from '../../lib/api-types'

/** The four metrics that answer "is the agent good?" at a glance; the rest
 * live in the compact table beneath them. */
export const HERO_METRICS = ['task_success', 'groundedness', 'safety', 'agent_latency_ms']

function Delta({ row }: { row: EvalMetricOverviewRow }) {
  if (row.delta === null) return <span className="text-zinc-400">—</span>
  const good = isDeltaGood(row.metric, row.delta)
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
        good ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
      }`}
    >
      {row.delta >= 0 ? <ArrowUpRight size={11} weight="bold" /> : <ArrowDownRight size={11} weight="bold" />}
      {row.delta >= 0 ? '+' : ''}
      {formatMetricValue(row.metric, row.delta)}
    </span>
  )
}

/** One hero KPI tile on the Evals overview: current-period mean, delta vs the
 * previous period ("—" when there is no prior period) and the sample size.
 * A raw-value metric (latency/tokens/steps/tool_errors) shows its number
 * as-is; a 0..1 rubric metric shows a percentage. */
export function MetricCard({ row }: { row: EvalMetricOverviewRow }) {
  const label = METRIC_LABELS[row.metric] ?? row.metric
  const tooltip = METRIC_TOOLTIPS[row.metric]
  return (
    <div className="ui-card flex min-w-0 flex-col p-4">
      <p className="text-xs leading-snug font-medium text-zinc-500" title={tooltip}>
        {label}
      </p>
      <p className="mt-2 font-[family-name:var(--font-display)] text-[1.75rem] leading-none font-semibold tracking-[-0.02em] text-zinc-950 tabular-nums">
        {formatMetricValue(row.metric, row.latest_mean)}
      </p>
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        <Delta row={row} />
        <span className="text-zinc-400 tabular-nums">n={row.n}</span>
      </div>
    </div>
  )
}

/** Every non-hero metric as one compact, scannable table (no truncation). */
export function MetricTable({ rows }: { rows: EvalMetricOverviewRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="ui-card overflow-x-auto">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col" className="px-4 py-2">
              Metric
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              Mean
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              Change
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              Samples
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <td className="px-4 py-2.5 text-zinc-800" title={METRIC_TOOLTIPS[row.metric]}>
                {METRIC_LABELS[row.metric] ?? row.metric}
              </td>
              <td className="px-4 py-2.5 text-right font-medium text-zinc-950">{formatMetricValue(row.metric, row.latest_mean)}</td>
              <td className="px-4 py-2.5 text-right">
                <Delta row={row} />
              </td>
              <td className="px-4 py-2.5 text-right text-zinc-500">{row.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
