import type { RunSnapshot } from './api-types'
import { buildTurnMetrics, formatDuration } from './chat-metrics'

export interface CompareRow {
  label: string
  a: string
  b: string
  /** Which side is lower, for a lower-is-better metric; null = tie / no judgment. */
  lowerIsBetter: 'a' | 'b' | null
}

function pickLower(a: number, b: number): 'a' | 'b' | null {
  if (a === b) return null
  return a < b ? 'a' : 'b'
}

/** Side-by-side numbers for two playground runs on the same input. */
export function compareRuns(a: RunSnapshot | null, b: RunSnapshot | null): CompareRow[] {
  if (!a || !b) return []
  const ma = buildTurnMetrics(a.started_at, a.history, false)
  const mb = buildTurnMetrics(b.started_at, b.history, false)
  return [
    { label: 'Status', a: a.status, b: b.status, lowerIsBetter: null },
    { label: 'Steps', a: String(ma.steps), b: String(mb.steps), lowerIsBetter: pickLower(ma.steps, mb.steps) },
    { label: 'Tool calls', a: String(ma.toolCalls), b: String(mb.toolCalls), lowerIsBetter: null },
    {
      label: 'Tokens',
      a: ma.totalTokens.toLocaleString(),
      b: mb.totalTokens.toLocaleString(),
      lowerIsBetter: pickLower(ma.totalTokens, mb.totalTokens),
    },
    {
      label: 'Time',
      a: formatDuration(ma.durationMs),
      b: formatDuration(mb.durationMs),
      lowerIsBetter: pickLower(ma.durationMs, mb.durationMs),
    },
    {
      label: 'Answer length',
      a: `${(a.final_answer ?? '').length} chars`,
      b: `${(b.final_answer ?? '').length} chars`,
      lowerIsBetter: null,
    },
  ]
}
