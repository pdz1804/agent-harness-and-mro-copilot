import { ArrowSquareOut, CheckCircle, Timer, WarningCircle } from '@phosphor-icons/react'
import type { ToolCallRow } from '../../lib/api-types'
import { formatLatency, summarizeArgs } from '../../lib/integration-limits'

const MAX_ROWS = 15

const OUTCOME = {
  ok: { label: 'OK', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200', icon: CheckCircle },
  error: { label: 'Error', cls: 'bg-rose-50 text-rose-800 ring-rose-200', icon: WarningCircle },
  timeout: { label: 'Timeout', cls: 'bg-amber-50 text-amber-800 ring-amber-200', icon: Timer },
} as const

/** Newest first, capped at 15 rows. */
export function RecentCalls({ calls }: { calls: ToolCallRow[] }) {
  const rows = [...calls].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ROWS)
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200">
      <table className="ui-table">
        <thead>
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Outcome</th>
            <th className="px-3 py-2 text-right">Latency</th>
            <th className="px-3 py-2 text-right">Attempt</th>
            <th className="px-3 py-2">Args</th>
            <th className="px-3 py-2">Error</th>
            <th className="px-3 py-2">Run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((call, i) => {
            const o = OUTCOME[call.outcome] ?? OUTCOME.error
            const Icon = o.icon
            return (
              <tr key={`${call.run_id}-${call.step}-${i}`} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap text-zinc-700">
                  {new Date(call.timestamp * 1000).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${o.cls}`}
                  >
                    <Icon size={12} weight="fill" aria-hidden="true" />
                    {o.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-zinc-700">{formatLatency(call.latency_ms)}</td>
                <td className="px-3 py-2 text-right text-zinc-700">{call.attempt ?? '—'}</td>
                <td className="max-w-56 px-3 py-2">
                  <span
                    className="font-data block truncate text-zinc-700"
                    title={call.args ? JSON.stringify(call.args, null, 2) : undefined}
                  >
                    {summarizeArgs(call.args, 60)}
                  </span>
                </td>
                <td className="max-w-56 px-3 py-2 text-rose-800 [overflow-wrap:anywhere]">{call.error ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <a
                    href={`/runs/${encodeURIComponent(call.run_id)}`}
                    className="ui-btn-link inline-flex items-center gap-1"
                  >
                    Open run
                    <ArrowSquareOut size={12} aria-hidden="true" />
                  </a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
