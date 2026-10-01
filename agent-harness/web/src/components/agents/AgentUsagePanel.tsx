import { CheckCircle, Circle, WarningCircle, XCircle } from '@phosphor-icons/react'
import { useState } from 'react'
import { formatAvgSteps, formatSuccessRate, successRateTitle, summarizeStatuses } from '../../lib/agent-usage'
import { Card, ErrorState, Skeleton, Table } from '../ui'
import { useAgentStats } from './use-agent-stats'

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle size={13} weight="fill" className="text-emerald-700" aria-hidden="true" />
  if (status === 'failed') return <XCircle size={13} weight="fill" className="text-rose-700" aria-hidden="true" />
  if (status === 'cancelled' || status === 'pending_approval')
    return <WarningCircle size={13} weight="fill" className="text-amber-700" aria-hidden="true" />
  return <Circle size={13} className="text-zinc-600" aria-hidden="true" />
}

/** Usage tab of the agent editor: headline numbers plus the by-status table. */
export function AgentUsagePanel({ agentId }: { agentId: string }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const state = useAgentStats(agentId, refreshKey)

  if (state.phase === 'loading') return <Skeleton className="h-40 w-full rounded-[14px]" />
  if (state.phase === 'error') {
    return <ErrorState message="Could not load usage stats for this agent." onRetry={() => setRefreshKey((n) => n + 1)} />
  }
  const { stats } = state
  const statuses = summarizeStatuses(stats.by_status)

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3 tabular-nums">
        <Card padding="sm">
          <dt className="text-xs text-zinc-500">Runs</dt>
          <dd className="mt-1 text-lg font-semibold text-zinc-900">{stats.runs}</dd>
        </Card>
        <Card padding="sm" title={successRateTitle(stats.scored_runs)}>
          <dt className="text-xs text-zinc-500">Eval success</dt>
          <dd className="mt-1 text-lg font-semibold text-zinc-900">
            {formatSuccessRate(stats.success_rate, stats.scored_runs)}
          </dd>
          <dd className="text-xs text-zinc-600">{stats.scored_runs} scored</dd>
        </Card>
        <Card padding="sm">
          <dt className="text-xs text-zinc-500">Avg steps</dt>
          <dd className="mt-1 text-lg font-semibold text-zinc-900">{formatAvgSteps(stats.avg_steps)}</dd>
        </Card>
      </dl>

      {statuses.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-[var(--color-line-strong)] p-4 text-center text-xs text-zinc-600">
          No runs yet. Use the Test chat tab to start one; usage appears here.
        </p>
      ) : (
        <Table label="Runs by status">
          <thead>
            <tr>
              <th>Status</th>
              <th className="text-right">Runs</th>
              <th className="text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.status}>
                <td>
                  <span className="inline-flex items-center gap-1.5 text-zinc-800">
                    <StatusIcon status={s.status} />
                    <span className="font-data">{s.status}</span>
                  </span>
                </td>
                <td className="text-right tabular-nums">{s.count}</td>
                <td className="text-right tabular-nums">{Math.round(s.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
