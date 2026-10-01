import type { AgentEvent, RunSnapshot } from './api-types'

function seconds(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value >= 60 && value % 60 === 0) return `${value / 60} min`
  return `${Math.round(value * 10) / 10}s`
}

function lastOf(history: AgentEvent[], type: AgentEvent['event_type']): AgentEvent | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].event_type === type) return history[i]
  return undefined
}

/** Why a finished run ended without an answer, as one plain sentence for the
 * thread ("Run stopped: ..."). `null` while the run is in flight, when it
 * completed, or when its final answer already explains the outcome. Built
 * from the persisted terminal events, so it never shows a half-streamed
 * fragment in place of the real outcome. */
export function stopReason(snapshot: Pick<RunSnapshot, 'status' | 'final_answer' | 'error' | 'history'>): string | null {
  const { status, history } = snapshot
  if (status === 'running' || status === 'pending_approval' || status === 'completed') return null
  if (snapshot.final_answer) return null
  switch (status) {
    case 'cancelled': {
      const timedOut = lastOf(history, 'approval_timed_out')
      if (timedOut || lastOf(history, 'run_cancelled')?.data.reason === 'approval_timeout') {
        const tool = typeof timedOut?.data.tool_name === 'string' ? timedOut.data.tool_name : 'the action'
        const limit = seconds(timedOut?.data.timeout_seconds)
        return `Approval timed out: nobody approved or denied ${tool}${limit ? ` within ${limit}` : ''}. Nothing was changed.`
      }
      return 'You stopped this run before the agent finished.'
    }
    case 'time_limit_exceeded': {
      const limit = seconds(lastOf(history, 'time_limit_exceeded')?.data.limit_seconds)
      return `Time limit exceeded: the agent used its${limit ? ` ${limit}` : ''} compute budget before answering.`
    }
    case 'step_limit_exceeded': {
      const limit = lastOf(history, 'step_limit_exceeded')?.data.limit
      return `Step limit reached${typeof limit === 'number' ? ` (${limit} steps)` : ''} before the agent answered.`
    }
    case 'llm_error_exceeded':
      return 'The model kept returning responses the harness could not use, so the run gave up.'
    case 'guardrail_blocked':
      return 'Blocked by a guardrail before the agent started.'
    case 'failed':
      return `Run failed unexpectedly${snapshot.error ? `: ${snapshot.error}` : '.'}`
    default:
      return null
  }
}
