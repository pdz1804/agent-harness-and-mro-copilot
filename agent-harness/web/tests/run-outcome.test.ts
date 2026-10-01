import { describe, expect, it } from 'vitest'
import type { AgentEvent, RunSnapshot } from '../src/lib/api-types'
import { stopReason } from '../src/lib/run-outcome'

const ev = (event_type: AgentEvent['event_type'], data: Record<string, unknown> = {}): AgentEvent => ({
  run_id: 'r',
  step: 1,
  event_type,
  timestamp: 1,
  latency_ms: null,
  data,
})

const snap = (over: Partial<RunSnapshot>): Pick<RunSnapshot, 'status' | 'final_answer' | 'error' | 'history'> => ({
  status: 'running',
  final_answer: null,
  error: null,
  history: [],
  ...over,
})

describe('stopReason', () => {
  it('is null while in flight or after a normal completion', () => {
    expect(stopReason(snap({ status: 'running' }))).toBeNull()
    expect(stopReason(snap({ status: 'pending_approval' }))).toBeNull()
    expect(stopReason(snap({ status: 'completed', final_answer: 'ok' }))).toBeNull()
  })

  it('explains an approval timeout instead of calling it a denial', () => {
    const reason = stopReason(
      snap({
        status: 'cancelled',
        history: [
          ev('approval_requested', { tool_name: 'create_dashboard' }),
          ev('approval_timed_out', { tool_name: 'create_dashboard', timeout_seconds: 900 }),
          ev('run_cancelled', { reason: 'approval_timeout' }),
        ],
      }),
    )
    expect(reason).toBe('Approval timed out: nobody approved or denied create_dashboard within 15 min. Nothing was changed.')
  })

  it('distinguishes a user stop from a timeout', () => {
    expect(stopReason(snap({ status: 'cancelled', history: [ev('run_cancelled', { reason: 'user' })] }))).toBe(
      'You stopped this run before the agent finished.',
    )
  })

  it('names the limit for time and step limits', () => {
    expect(stopReason(snap({ status: 'time_limit_exceeded', history: [ev('time_limit_exceeded', { limit_seconds: 60 })] }))).toBe(
      'Time limit exceeded: the agent used its 1 min compute budget before answering.',
    )
    expect(stopReason(snap({ status: 'step_limit_exceeded', history: [ev('step_limit_exceeded', { limit: 12 })] }))).toBe(
      'Step limit reached (12 steps) before the agent answered.',
    )
  })

  it('reports failures with the server error, and defers to an explaining final answer', () => {
    expect(stopReason(snap({ status: 'failed', error: 'boom' }))).toBe('Run failed unexpectedly: boom')
    expect(stopReason(snap({ status: 'guardrail_blocked', final_answer: 'Blocked by guardrail x' }))).toBeNull()
  })
})
