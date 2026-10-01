export const TIMEOUT_MIN = 0.1
export const TIMEOUT_MAX = 300
export const RETRIES_MIN = 0
export const RETRIES_MAX = 10

/** `value: null` means "clear the override / use the global default" and is
 * what a blank input produces; the form always sends both fields. */
export type ParseResult = { ok: true; value: number | null } | { ok: false; error: string }

export function parseTimeout(input: string): ParseResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { ok: false, error: 'Timeout must be a number of seconds.' }
  if (value < TIMEOUT_MIN || value > TIMEOUT_MAX) {
    return { ok: false, error: `Timeout must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} seconds.` }
  }
  return { ok: true, value }
}

export function parseRetries(input: string): ParseResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: null }
  const value = Number(trimmed)
  if (!Number.isInteger(value)) return { ok: false, error: 'Retries must be a whole number.' }
  if (value < RETRIES_MIN || value > RETRIES_MAX) {
    return { ok: false, error: `Retries must be between ${RETRIES_MIN} and ${RETRIES_MAX}.` }
  }
  return { ok: true, value }
}

export function describeLimit(value: number, overridden: boolean): string {
  return `${value} (${overridden ? 'overridden' : 'global default'})`
}

/** `rate` is a 0..1 fraction; null means no calls yet. */
export function formatErrorRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  const pct = rate * 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

/** One-line JSON of `args`, truncated with an ellipsis at `maxLen` characters. */
export function summarizeArgs(args: Record<string, unknown> | null | undefined, maxLen: number): string {
  if (!args || Object.keys(args).length === 0) return '—'
  const text = JSON.stringify(args)
  if (text.length <= maxLen) return text
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`
}
