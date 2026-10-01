import { ArrowDown, ArrowUp } from '@phosphor-icons/react'
import type { DashboardWidget } from '../../lib/api-types'

function formatValue(raw: unknown, format: string | undefined, suffix: string | null | undefined): string {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (Number.isNaN(n)) return String(raw ?? '—')
  let text: string
  switch (format) {
    case 'percent':
      text = `${(n * 100).toFixed(1)}%`
      break
    case 'duration_ms':
      text = n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
      break
    case 'currency':
      text = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n)
      break
    default:
      text = new Intl.NumberFormat().format(n)
  }
  return suffix ? `${text}${suffix}` : text
}

/** Renders a `stat` widget's already-validated single-row result: one big
 * number plus an optional delta indicator. Shape (exactly 1 row,
 * `value_col` present) is guaranteed by the backend's `check_result_shape`
 * before this ever renders — a mismatch surfaces as `last_error` instead
 * (see `WidgetFrame`). */
export function StatWidget({ widget }: { widget: DashboardWidget }) {
  const result = widget.last_result
  if (!result || result.rows.length === 0) return null
  const row = result.rows[0]
  const { value_col, format, delta_col, suffix } = widget.config

  const value = value_col ? row[value_col] : undefined
  const delta = delta_col ? row[delta_col] : undefined
  const deltaNum = typeof delta === 'number' ? delta : Number(delta)

  return (
    <div className="flex flex-col items-start">
      <p className="font-[family-name:var(--font-display)] text-[2rem] leading-none font-semibold tracking-[-0.025em] text-zinc-950 tabular-nums">
        {formatValue(value, format, suffix)}
      </p>
      {delta_col && !Number.isNaN(deltaNum) && (
        <p
          className={`mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
            deltaNum > 0 ? 'bg-emerald-50 text-emerald-700' : deltaNum < 0 ? 'bg-rose-50 text-rose-700' : 'bg-zinc-100 text-zinc-500'
          }`}
        >
          {deltaNum > 0 ? (
            <ArrowUp size={12} weight="bold" />
          ) : deltaNum < 0 ? (
            <ArrowDown size={12} weight="bold" />
          ) : null}
          {formatValue(Math.abs(deltaNum), format, null)}
        </p>
      )}
    </div>
  )
}
