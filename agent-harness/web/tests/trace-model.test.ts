import { describe, expect, it } from 'vitest'
import { buildReasoning, buildToolCalls, categorize } from '../src/lib/trace-model'
import type { AgentEvent } from '../src/lib/api-types'

function ev(partial: Partial<AgentEvent> & Pick<AgentEvent, 'step' | 'event_type'>): AgentEvent {
  return {
    run_id: 'r1',
    timestamp: 0,
    latency_ms: null,
    data: {},
    ...partial,
  }
}

describe('buildToolCalls', () => {
  it('correlates a plain started -> result pair', () => {
    const events = [
      ev({ step: 0, event_type: 'tool_call_started', data: { tool_name: 'get_service_status', args: { name: 'x' }, attempt: 1 } }),
      ev({ step: 0, event_type: 'tool_call_result', latency_ms: 42, data: { tool_name: 'get_service_status', args: { name: 'x' }, attempt: 1, output: { status: 'down' } } }),
    ]
    const calls = buildToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('ok')
    expect(calls[0].result).toEqual({ status: 'down' })
    expect(calls[0].latencyMs).toBe(42)
    expect(calls[0].args).toEqual({ name: 'x' })
  })

  it('retries then succeeds, keeping the final outcome and attempt count', () => {
    const events = [
      ev({ step: 1, event_type: 'tool_call_started', data: { tool_name: 'search_kb', args: {}, attempt: 1 } }),
      ev({ step: 1, event_type: 'tool_call_retry', data: { tool_name: 'search_kb', next_attempt: 2 } }),
      ev({ step: 1, event_type: 'tool_call_result', data: { tool_name: 'search_kb', args: {}, attempt: 2, output: { hits: 3 } } }),
    ]
    const calls = buildToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('ok')
    expect(calls[0].attempts).toBe(2)
  })

  it('reports a timeout distinctly from an error', () => {
    const events = [
      ev({ step: 2, event_type: 'tool_call_started', data: { tool_name: 'create_incident', args: {}, attempt: 1 } }),
      ev({ step: 2, event_type: 'tool_call_timeout', data: { tool_name: 'create_incident', timeout_seconds: 10 } }),
    ]
    const calls = buildToolCalls(events)
    expect(calls[0].status).toBe('timeout')
    expect(calls[0].error).toContain('10s')
  })

  it('handles a validation error with no tool_call_started counterpart', () => {
    const events = [
      ev({
        step: 0,
        event_type: 'tool_validation_error',
        latency_ms: 1,
        data: { tool_name: 'create_incident', args: { bad: true }, error: 'missing field: severity' },
      }),
    ]
    const calls = buildToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('invalid')
    expect(calls[0].error).toBe('missing field: severity')
  })

  it('records an approval denial with no execution ever happening', () => {
    const events = [
      ev({ step: 3, event_type: 'approval_requested', data: { tool_name: 'create_incident', args: { severity: 'critical' } } }),
      ev({ step: 3, event_type: 'approval_denied', data: { tool_name: 'create_incident' } }),
    ]
    const calls = buildToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('denied')
    expect(calls[0].approvalOutcome).toBe('denied')
    expect(calls[0].result).toBeNull()
  })

  it('keeps two parallel-looking calls of the same tool in the same step distinct', () => {
    const events = [
      ev({ step: 0, event_type: 'tool_call_started', data: { tool_name: 'get_service_status', args: { name: 'a' }, attempt: 1 } }),
      ev({ step: 0, event_type: 'tool_call_started', data: { tool_name: 'get_service_status', args: { name: 'b' }, attempt: 1 } }),
      ev({ step: 0, event_type: 'tool_call_result', data: { tool_name: 'get_service_status', args: { name: 'a' }, attempt: 1, output: { status: 'up' } } }),
      ev({ step: 0, event_type: 'tool_call_result', data: { tool_name: 'get_service_status', args: { name: 'b' }, attempt: 1, output: { status: 'down' } } }),
    ]
    const calls = buildToolCalls(events)
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toEqual({ name: 'a' })
    expect(calls[0].result).toEqual({ status: 'up' })
    expect(calls[1].args).toEqual({ name: 'b' })
    expect(calls[1].result).toEqual({ status: 'down' })
  })
})

describe('categorize', () => {
  it('buckets skill-routing events under "routing"', () => {
    expect(categorize(ev({ step: 0, event_type: 'skill_routed' }))).toBe('routing')
    expect(categorize(ev({ step: 0, event_type: 'skill_invoked' }))).toBe('routing')
  })

  it('buckets guardrail events under "guardrails"', () => {
    expect(categorize(ev({ step: 0, event_type: 'guardrail_blocked' }))).toBe('guardrails')
  })
})

describe('buildReasoning', () => {
  it('extracts skill_routed rationale/confidence and llm_decision rationale, never fabricating either', () => {
    const events = [
      ev({
        step: 0,
        event_type: 'skill_routed',
        data: { candidates: ['a', 'b'], selected: ['a'], rationale: 'matches a', confidence: 0.8 },
      }),
      ev({ step: 1, event_type: 'llm_decision', data: { action: 'tool_call', rationale: 'checking status first' } }),
      ev({ step: 2, event_type: 'llm_decision', data: { action: 'final_answer', rationale: null } }),
    ]
    const { routed, decisions } = buildReasoning(events)
    expect(routed).toEqual([{ step: 0, candidates: ['a', 'b'], selected: ['a'], rationale: 'matches a', confidence: 0.8 }])
    expect(decisions).toHaveLength(2)
    expect(decisions[0].text).toBe('checking status first')
    expect(decisions[1].text).toBeNull()
  })
})

describe('buildToolCalls approval lifecycle', () => {
  it('shows an approval-gated call as awaiting approval until a decision arrives', () => {
    const calls = buildToolCalls([
      ev({ step: 2, event_type: 'approval_requested', timestamp: 10, data: { tool_name: 'create_incident', args: { title: 't' }, preview: { kind: 'x' } } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('awaiting_approval')
    expect(calls[0].approvalPreview).toEqual({ kind: 'x' })
  })

  it('keeps an approved call as ONE row through execution (no phantom running row)', () => {
    const calls = buildToolCalls([
      ev({ step: 2, event_type: 'approval_requested', timestamp: 10, data: { tool_name: 'create_incident', args: { title: 't' } } }),
      ev({ step: 2, event_type: 'approval_granted', timestamp: 12, data: { tool_name: 'create_incident', args: { title: 't' } } }),
      ev({ step: 2, event_type: 'tool_call_started', timestamp: 12, data: { tool_name: 'create_incident', args: { title: 't' }, attempt: 1 } }),
      ev({ step: 2, event_type: 'tool_call_result', timestamp: 13, latency_ms: 30, data: { tool_name: 'create_incident', result: { id: 'INC-1' } } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('ok')
    expect(calls[0].approvalOutcome).toBe('granted')
    expect(calls[0].decidedAt).toBe(12)
    expect(calls[0].result).toEqual({ id: 'INC-1' })
  })

  it('moves a granted call to started while it executes', () => {
    const calls = buildToolCalls([
      ev({ step: 1, event_type: 'approval_requested', data: { tool_name: 'x', args: {} } }),
      ev({ step: 1, event_type: 'approval_granted', data: { tool_name: 'x' } }),
    ])
    expect(calls.map((c) => c.status)).toEqual(['started'])
  })
})
