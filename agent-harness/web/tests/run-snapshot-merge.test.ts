import { describe, expect, it } from 'vitest'
import type { AgentEvent, RunSnapshot } from '../src/lib/api-types'
import { mergeSnapshot } from '../src/lib/run-snapshot-merge'

const ev = (step: number, event_type: AgentEvent['event_type'], timestamp: number): AgentEvent => ({
  run_id: 'r1',
  step,
  event_type,
  timestamp,
  latency_ms: null,
  data: {},
})

const snapshot = (over: Partial<RunSnapshot>): RunSnapshot =>
  ({
    run_id: 'r1',
    objective: 'o',
    status: 'running',
    started_at: 0,
    history: [],
    pending_approval: null,
    final_answer: null,
    error: null,
    ...over,
  }) as RunSnapshot

describe('mergeSnapshot', () => {
  it('takes the fetched snapshot when there is nothing newer locally', () => {
    const next = snapshot({ status: 'pending_approval', history: [ev(0, 'skill_routed', 1), ev(1, 'approval_requested', 2)] })
    expect(mergeSnapshot(snapshot({ history: [ev(0, 'skill_routed', 1)] }), next)).toBe(next)
  })

  it('keeps events streamed after the fetch was issued', () => {
    const prev = snapshot({ history: [ev(0, 'skill_routed', 1), ev(1, 'llm_decision', 2), ev(1, 'tool_call_started', 3)] })
    const next = snapshot({ history: [ev(0, 'skill_routed', 1), ev(1, 'llm_decision', 2)] })
    const merged = mergeSnapshot(prev, next)
    expect(merged.history.map((e) => e.event_type)).toEqual(['skill_routed', 'llm_decision', 'tool_call_started'])
  })

  it('never resurrects local events the server history already supersedes', () => {
    const prev = snapshot({ history: [ev(1, 'tool_call_started', 1)] })
    const next = snapshot({ status: 'completed', history: [ev(1, 'tool_call_result', 5)] })
    expect(mergeSnapshot(prev, next).history.map((e) => e.event_type)).toEqual(['tool_call_result'])
  })

  it('ignores a previous snapshot of another run', () => {
    const next = snapshot({ run_id: 'r2' })
    expect(mergeSnapshot(snapshot({ history: [ev(1, 'llm_decision', 9)] }), next)).toBe(next)
  })
})
