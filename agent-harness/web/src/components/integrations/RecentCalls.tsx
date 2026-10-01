import { ArrowSquareOut } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import type { ToolCallRow } from '../../lib/api-types'
import { formatLatency, summarizeArgs } from '../../lib/integration-limits'
import { Chip, RelativeTime, Row, Table, type ChipTone } from '../ui'

const MAX_ROWS = 15

const OUTCOME: Record<ToolCallRow['outcome'], { label: string; tone: ChipTone }> = {
  ok: { label: 'OK', tone: 'ok' },
  error: { label: 'Error', tone: 'danger' },
  timeout: { label: 'Timeout', tone: 'warn' },
}

/** Newest first, capped at 15 rows. */
export function RecentCalls({ calls }: { calls: ToolCallRow[] }) {
  const rows = [...calls].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ROWS)
  return (
    <Table label="Recent calls">
      <thead>
        <tr>
          <th>Outcome</th>
          <th className="hidden sm:table-cell">When</th>
          <th className="text-right">Latency</th>
          <th>Details</th>
          <th className="w-10">
            <span className="sr-only">Open run</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((call, i) => {
          const o = OUTCOME[call.outcome] ?? OUTCOME.error
          return (
            <Row key={`${call.run_id}-${call.step}-${i}`} className="align-top">
              <td>
                <Chip tone={o.tone} dot>
                  {o.label}
                </Chip>
                {call.attempt !== null && call.attempt > 1 && <span className="ml-1.5 text-xs text-zinc-500">attempt {call.attempt}</span>}
              </td>
              <td className="hidden whitespace-nowrap text-zinc-600 sm:table-cell">
                <RelativeTime value={call.timestamp} />
              </td>
              <td className="text-right whitespace-nowrap text-zinc-700 tabular-nums">{formatLatency(call.latency_ms)}</td>
              <td className="max-w-0 min-w-[8rem]">
                <span className="font-data block truncate text-xs text-zinc-700" title={call.args ? JSON.stringify(call.args, null, 2) : undefined}>
                  {summarizeArgs(call.args, 60)}
                </span>
                {call.error && <span className="block text-xs text-rose-800 [overflow-wrap:anywhere]">{call.error}</span>}
              </td>
              <td className="text-right">
                <Link to={`/runs/${encodeURIComponent(call.run_id)}`} className="ui-btn-link inline-flex items-center" aria-label={`Open run ${call.run_id}`} title="Open run">
                  <ArrowSquareOut size={14} aria-hidden="true" />
                </Link>
              </td>
            </Row>
          )
        })}
      </tbody>
    </Table>
  )
}
