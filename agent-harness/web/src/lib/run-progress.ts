import type { AgentEvent } from './api-types'
import { formatDuration } from './time'

/** Events that read as a "step" to someone watching the thread: a decision,
 * a tool call finishing (any outcome), an approval request or the answer.
 * Token deltas and bookkeeping events are not steps. */
const STEP_EVENTS = new Set<AgentEvent['event_type']>([
  'llm_decision',
  'tool_call_result',
  'tool_call_error',
  'tool_call_timeout',
  'approval_requested',
  'final_answer',
  'guardrail_blocked',
])

export function countSteps(history: readonly AgentEvent[], fromIndex = 0): number {
  let n = 0
  for (let i = Math.max(0, fromIndex); i < history.length; i += 1) if (STEP_EVENTS.has(history[i].event_type)) n += 1
  return n
}

/** "Jump to latest" / "Jump to latest · 3 new steps". */
export function jumpLabel(newSteps: number): string {
  if (newSteps <= 0) return 'Jump to latest'
  return `Jump to latest · ${newSteps} new step${newSteps === 1 ? '' : 's'}`
}

/** Unix seconds of the most recent `approval_requested`, or null. The API has
 * no approval deadline, so the bar shows how long the run has waited, never
 * a countdown. */
export function approvalRequestedAt(history: readonly AgentEvent[]): number | null {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].event_type === 'approval_requested') return history[i].timestamp
  return null
}

/** "Waiting for approval · 1m 12s" (or without the time when unknown). */
export function waitingLabel(requestedAt: number | null, nowMs: number): string {
  if (requestedAt === null) return 'Waiting for approval'
  const elapsed = formatDuration(Math.max(0, nowMs - requestedAt * 1000))
  return elapsed ? `Waiting for approval · ${elapsed}` : 'Waiting for approval'
}
