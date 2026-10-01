import { useId } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { buildPieData, needsSparseTrendFallback } from '../../lib/widget-shapes'
import type { DashboardWidget } from '../../lib/api-types'
import { AXIS_PROPS, CHART_PALETTE as PALETTE, CURSOR_BAR, CURSOR_LINE, ChartTooltip, GRID_PROPS, allIntegers, statusColor } from './chart-theme'

/** Renders `line`/`bar`/`area`/`pie` widgets via recharts, responsive to
 * the widget's actual pixel size (`ResponsiveContainer`, not a fixed
 * width) so the same widget looks right at both 12-col and 3-col spans and
 * on a narrow (375px) viewport. Styling: hairline horizontal grid only,
 * axis-less ticks, gradient areas, rounded bars, donut + legend for pies. */
export function ChartWidget({ widget }: { widget: DashboardWidget }) {
  const gradientId = useId().replace(/:/g, '')
  const result = widget.last_result
  if (!result || result.rows.length === 0) {
    return <p className="py-8 text-center text-xs text-zinc-500">No rows returned.</p>
  }
  const { kind, config } = widget

  if (kind === 'pie') {
    const data = buildPieData(result.rows, config.label_col!, config.value_col!)
    const total = data.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
    return (
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="relative h-[180px] w-[180px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip content={<ChartTooltip />} />
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={58}
                outerRadius={84}
                paddingAngle={data.length > 1 ? 2 : 0}
                cornerRadius={4}
                stroke="none"
              >
                {data.map((d, i) => (
                  <Cell key={i} fill={statusColor(d.name) ?? PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight text-zinc-950 tabular-nums">
              {total.toLocaleString()}
            </span>
            <span className="text-[11px] text-zinc-500">total</span>
          </div>
        </div>
        <ul className="w-full min-w-0 space-y-1.5 text-xs">
          {data.map((d, i) => (
            <li key={`${d.name}-${i}`} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(d.name) ?? PALETTE[i % PALETTE.length] }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-zinc-600">{d.name}</span>
              <span className="font-data text-zinc-900 tabular-nums">{Number(d.value).toLocaleString()}</span>
              <span className="w-10 text-right text-zinc-400 tabular-nums">
                {total ? `${Math.round((Number(d.value) / total) * 100)}%` : '—'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const xCol = config.x_col!
  const yCols = config.y_cols ?? []
  const data = result.rows
  const sparseFallback = needsSparseTrendFallback(kind, data.length)
  const integerTicks = allIntegers(data, yCols)
  const yAxis = <YAxis {...AXIS_PROPS} allowDecimals={!integerTicks} />

  if (kind === 'bar' || sparseFallback) {
    // Few categories, one series: label the bars directly and drop the y-axis.
    const labelled = yCols.length === 1 && !config.stacked && data.length <= 8
    return (
      <div>
        {sparseFallback && (
          <p className="mb-1.5 text-xs text-zinc-500">
            Only {data.length} data point{data.length === 1 ? '' : 's'} — showing as bars instead of an (invisible) trend line.
          </p>
        )}
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: labelled ? 20 : 8, right: 4, left: labelled ? 4 : -12, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey={xCol} {...AXIS_PROPS} />
            {labelled ? <YAxis hide allowDecimals={!integerTicks} /> : yAxis}
            <Tooltip content={<ChartTooltip />} cursor={CURSOR_BAR} />
            {yCols.map((y, i) => (
              <Bar
                key={y}
                dataKey={y}
                fill={PALETTE[i % PALETTE.length]}
                radius={config.stacked && i < yCols.length - 1 ? 0 : [5, 5, 1, 1]}
                maxBarSize={40}
                stackId={config.stacked ? 'stack' : undefined}
              >
                {yCols.length === 1 &&
                  data.map((row, j) => <Cell key={j} fill={statusColor(row[xCol]) ?? PALETTE[0]} />)}
                {labelled && <LabelList dataKey={y} position="top" offset={6} className="fill-zinc-600 text-[11px] tabular-nums" />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (kind === 'area') {
    return (
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
          <defs>
            {yCols.map((y, i) => (
              <linearGradient key={y} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.28} />
                <stop offset="100%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey={xCol} {...AXIS_PROPS} />
          {yAxis}
          <Tooltip content={<ChartTooltip />} cursor={CURSOR_LINE} />
          {yCols.map((y, i) => (
            <Area
              key={y}
              type="monotone"
              dataKey={y}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              fill={`url(#${gradientId}-${i})`}
              activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
              stackId={config.stacked ? 'stack' : undefined}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  // line (default)
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey={xCol} {...AXIS_PROPS} />
        {yAxis}
        <Tooltip content={<ChartTooltip />} cursor={CURSOR_LINE} />
        {yCols.map((y, i) => (
          <Line
            key={y}
            type="monotone"
            dataKey={y}
            stroke={PALETTE[i % PALETTE.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
