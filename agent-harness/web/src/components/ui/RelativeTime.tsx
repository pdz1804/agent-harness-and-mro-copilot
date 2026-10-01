import { formatAbsolute, formatRelative, toDate, type TimeInput } from '../../lib/time'

/** "5m ago" with the absolute time on hover; `fallback` when absent. */
export function RelativeTime({ value, fallback = '—', className = '' }: { value: TimeInput; fallback?: string; className?: string }) {
  const date = toDate(value)
  if (!date) return <span className={className}>{fallback}</span>
  return (
    <time dateTime={date.toISOString()} title={formatAbsolute(date)} className={`tabular-nums ${className}`}>
      {formatRelative(date)}
    </time>
  )
}
