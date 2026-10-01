import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { AgentStats } from '../../lib/api-types'

export type AgentStatsState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; stats: AgentStats }

/** Loads one agent's usage stats. A failure is isolated to `error` (callers
 * render "n/a") so one bad stat call never breaks a list of agents. */
export function useAgentStats(agentId: string, refreshKey: number = 0): AgentStatsState {
  const requestKey = `${agentId}:${refreshKey}`
  const [settled, setSettled] = useState<{ key: string; state: AgentStatsState } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getAgentStats(agentId)
      .then((stats) => {
        if (!cancelled) setSettled({ key: requestKey, state: { phase: 'ready', stats } })
      })
      .catch(() => {
        if (!cancelled) setSettled({ key: requestKey, state: { phase: 'error' } })
      })
    return () => {
      cancelled = true
    }
  }, [agentId, requestKey])

  // A result for a previous agent/refresh is stale: report loading until the new one lands.
  return settled && settled.key === requestKey ? settled.state : { phase: 'loading' }
}
