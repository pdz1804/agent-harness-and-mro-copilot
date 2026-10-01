import { formatAvgSteps, formatSuccessRate, successRateTitle } from '../../lib/agent-usage'
import { useAgentStats } from './use-agent-stats'

/** Compact one-line usage stats for an agent card: runs, eval success, avg steps. */
export function AgentUsageSummary({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const state = useAgentStats(agentId, refreshKey)

  if (state.phase === 'loading') {
    return (
      <p className="text-xs text-zinc-600" aria-busy="true">
        Loading usage…
      </p>
    )
  }
  if (state.phase === 'error') {
    return (
      <p className="text-xs text-zinc-600" title="Usage stats could not be loaded for this agent">
        Runs n/a · Success n/a · Steps n/a
      </p>
    )
  }
  const { stats } = state
  return (
    <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-zinc-600 tabular-nums">
      <div className="flex items-baseline gap-1">
        <dt>Runs</dt>
        <dd className="font-semibold text-zinc-900">{stats.runs}</dd>
      </div>
      <div className="flex items-baseline gap-1" title={successRateTitle(stats.scored_runs)}>
        <dt>Success</dt>
        <dd className="font-semibold text-zinc-900">{formatSuccessRate(stats.success_rate, stats.scored_runs)}</dd>
      </div>
      <div className="flex items-baseline gap-1">
        <dt>Avg steps</dt>
        <dd className="font-semibold text-zinc-900">{formatAvgSteps(stats.avg_steps)}</dd>
      </div>
    </dl>
  )
}
