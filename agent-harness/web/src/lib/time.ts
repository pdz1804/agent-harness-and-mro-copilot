/** One place for timestamp formatting. The API hands out two shapes: ISO
 * strings (most tables) and unix seconds (run/event clocks). `toDate` accepts
 * either, so callers never branch on the format. */

export type TimeInput = string | number | Date | null | undefined

/** A `Date` for any API timestamp, or `null` when absent or unparseable.
 * Numbers below 1e12 are unix seconds; larger ones are milliseconds. */
export function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return new Date(value < 1e12 ? value * 1000 : value)
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const ABSOLUTE_SECONDS = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const SHORT_DATE_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** "Oct 1, 2026, 3:25 PM": the single absolute format used across the app
 * (`seconds` adds the seconds, for logs and traces). '' when unparseable. */
export function formatAbsolute(value: TimeInput, opts: { seconds?: boolean } = {}): string {
  const date = toDate(value)
  if (!date) return ''
  return (opts.seconds ? ABSOLUTE_SECONDS : ABSOLUTE).format(date)
}

/** "just now", "5m ago", "3h ago", "yesterday", "4d ago", then a short date
 * ("Sep 3", or "Sep 3, 2025" in another year). Future times read "just now"
 * within 45 s and "in 5m" beyond. '' when unparseable. */
export function formatRelative(value: TimeInput, now: number = Date.now()): string {
  const date = toDate(value)
  if (!date) return ''
  const diffMs = now - date.getTime()
  const future = diffMs < 0
  const seconds = Math.floor(Math.abs(diffMs) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  const days = Math.round(hours / 24)
  if (!future && days === 1) return 'yesterday'
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`
  return date.getFullYear() === new Date(now).getFullYear() ? SHORT_DATE.format(date) : SHORT_DATE_YEAR.format(date)
}

/** "1h 12m" / "45s" / "3d 4h" for a duration in milliseconds; '' if invalid. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}
