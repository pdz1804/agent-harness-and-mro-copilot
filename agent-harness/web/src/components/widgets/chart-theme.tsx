import type { TooltipContentProps } from 'recharts'

/** One deterministic data palette for every chart (iris leads; then teal,
 * amber, rose, violet, cyan, olive). Distinct in lightness as well as hue so
 * adjacent series stay separable for common colour-vision deficiencies. */
export const CHART_PALETTE = ['#5b54e8', '#0f9f8f', '#e0901a', '#e5484d', '#a35ee8', '#1b98c7', '#7c8a2b']

const STATUS_COLORS: [RegExp, string][] = [
  [/^(operational|ok|healthy|completed|success|succeeded|resolved|up|pass|passed|granted|approved)$/, '#12a150'],
  [/^(degraded|warning|warn|pending|pending_approval|acknowledged|medium|retry|running|in_progress)$/, '#e0901a'],
  [/^(down|failed|failure|error|critical|high|open|denied|blocked|guardrail_blocked|timeout|fail)$/, '#e5484d'],
  [/^(low|idle|cancelled|unknown|none)$/, '#8b8fa3'],
]

/** When a chart's categories are statuses, colour them by meaning
 * (operational green / degraded amber / down red) instead of by palette
 * order. Returns null for non-status categories. */
export function statusColor(name: unknown): string | null {
  const key = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  for (const [pattern, color] of STATUS_COLORS) if (pattern.test(key)) return color
  return null
}

/** True when every numeric value in the given columns is an integer (counts),
 * so the y-axis must not tick at 0.25 steps. */
export function allIntegers(rows: Record<string, unknown>[], cols: string[]): boolean {
  return rows.every((r) => cols.every((c) => r[c] == null || Number.isInteger(Number(r[c]))))
}

export const AXIS_PROPS = {
  tick: { fontSize: 11, fill: 'oklch(0.552 0.017 272)' },
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
} as const

export const GRID_PROPS = {
  stroke: 'oklch(0.25 0.02 272 / 0.07)',
  vertical: false,
} as const

export const CURSOR_LINE = { stroke: 'oklch(0.25 0.02 272 / 0.18)', strokeWidth: 1 }
export const CURSOR_BAR = { fill: 'oklch(0.25 0.02 272 / 0.04)', radius: 6 }

function fmt(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return String(value ?? '')
}

/** Refined tooltip: white card, hairline, colour key, tabular values. */
export function ChartTooltip({ active, payload, label }: Partial<TooltipContentProps<number | string, string>>) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="min-w-36 rounded-lg border border-[var(--color-line)] bg-white/95 px-3 py-2 text-xs shadow-[var(--shadow-lg)] backdrop-blur">
      {label !== undefined && label !== '' && <p className="mb-1.5 font-medium text-zinc-900">{String(label)}</p>}
      <ul className="space-y-1">
        {payload.map((entry, i) => (
          <li key={`${String(entry.name)}-${i}`} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: (entry.color as string | undefined) ?? (entry.payload as { fill?: string } | undefined)?.fill }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-zinc-500">{String(entry.name)}</span>
            <span className="font-data font-medium text-zinc-900 tabular-nums">{fmt(entry.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
