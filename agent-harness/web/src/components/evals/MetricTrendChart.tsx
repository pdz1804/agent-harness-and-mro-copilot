import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { distinctMetrics, pivotSeriesByDate } from '../../lib/eval-shapes'
import type { EvalSeriesPoint } from '../../lib/api-types'

import { AXIS_PROPS, CHART_PALETTE as PALETTE, CURSOR_LINE, ChartTooltip, GRID_PROPS } from '../widgets/chart-theme'

// A single-point-per-day series renders as an invisible dot-less line
// (phase 06 polish note: "single-point line charts look empty") — fall
// back to distinct dots so at least one real data point is visible.
export function MetricTrendChart({ series }: { series: EvalSeriesPoint[] }) {
  const allMetrics = useMemo(() => distinctMetrics(series), [series])
  const [toggled, setToggled] = useState<Set<string>>(() => new Set(allMetrics.slice(0, 3)))

  const data = useMemo(() => pivotSeriesByDate(series), [series])

  function toggle(metric: string) {
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(metric)) next.delete(metric)
      else next.add(metric)
      return next
    })
  }

  if (series.length === 0) {
    return <p className="text-sm text-zinc-500">No scored runs in this window yet.</p>
  }

  const activeMetrics = allMetrics.filter((m) => toggled.has(m))

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {allMetrics.map((metric, i) => (
          <button
            key={metric}
            type="button"
            onClick={() => toggle(metric)}
            aria-pressed={toggled.has(metric)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
              toggled.has(metric) ? 'bg-zinc-950/[0.06] text-zinc-900' : 'text-zinc-500 hover:bg-zinc-950/[0.04] hover:text-zinc-800'
            }`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: toggled.has(metric) ? PALETTE[i % PALETTE.length] : 'oklch(0.708 0.014 272)' }}
              aria-hidden="true"
            />
            {metric}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="date" {...AXIS_PROPS} />
          <YAxis {...AXIS_PROPS} domain={[0, 'auto']} />
          <Tooltip content={<ChartTooltip />} cursor={CURSOR_LINE} />
          {activeMetrics.map((metric) => {
            const i = allMetrics.indexOf(metric)
            return (
              <Line
                key={metric}
                type="monotone"
                dataKey={metric}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                dot={data.filter((d) => d[metric] !== undefined).length < 2 ? { r: 3.5, strokeWidth: 0, fill: PALETTE[i % PALETTE.length] } : false}
                connectNulls
              />
            )
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
