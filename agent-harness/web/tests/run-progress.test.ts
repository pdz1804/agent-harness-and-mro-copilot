import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/lib/api-types'
import { limitError } from '../src/lib/run-limits'
import { approvalRequestedAt, countSteps, jumpLabel, waitingLabel } from '../src/lib/run-progress'

const ev = (event_type: AgentEvent['event_type'], timestamp = 100): AgentEvent => ({
  run_id: 'r',
  step: 1,
  event_type,
  timestamp,
  latency_ms: null,
  data: {},
})

describe('countSteps', () => {
  const history = [ev('llm_decision'), ev('llm_token_delta'), ev('tool_call_started'), ev('tool_call_result'), ev('approval_requested'), ev('final_answer')]
  it('counts only events that read as steps', () => {
    expect(countSteps(history)).toBe(4)
  })
  it('counts from an index (steps since the reader scrolled away)', () => {
    expect(countSteps(history, 3)).toBe(3)
    expect(countSteps(history, 99)).toBe(0)
    expect(countSteps(history, -5)).toBe(4)
  })
})

describe('jumpLabel', () => {
  it('names new steps when there are any', () => {
    expect(jumpLabel(0)).toBe('Jump to latest')
    expect(jumpLabel(1)).toBe('Jump to latest · 1 new step')
    expect(jumpLabel(3)).toBe('Jump to latest · 3 new steps')
  })
})

describe('approval waiting', () => {
  it('finds the latest approval request', () => {
    expect(approvalRequestedAt([ev('approval_requested', 10), ev('approval_granted', 20), ev('approval_requested', 30)])).toBe(30)
    expect(approvalRequestedAt([ev('llm_decision')])).toBeNull()
  })
  it('shows elapsed time, never a countdown', () => {
    expect(waitingLabel(null, 0)).toBe('Waiting for approval')
    expect(waitingLabel(100, 100_000 + 18_000)).toBe('Waiting for approval · 18s')
    expect(waitingLabel(100, 100_000 + 72_000)).toBe('Waiting for approval · 1m 12s')
    // Clock skew (server ahead of the browser) never shows a negative time.
    expect(waitingLabel(200, 100_000)).toBe('Waiting for approval · 0s')
  })
})

describe('limitError', () => {
  it('accepts empty (server default) and whole numbers >= 1', () => {
    expect(limitError('')).toBeNull()
    expect(limitError('  ')).toBeNull()
    expect(limitError('12')).toBeNull()
  })
  it('rejects fractions, negatives, zero and text', () => {
    expect(limitError('1.5')).toBe('Use a whole number.')
    expect(limitError('-3')).toBe('Use a whole number.')
    expect(limitError('abc')).toBe('Use a whole number.')
    expect(limitError('0')).toBe('Must be at least 1.')
  })
})
