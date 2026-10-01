import { describe, expect, it } from 'vitest'
import { artifactOf, stalledFor, summarizeArgs } from '../src/lib/tool-call-view'
import type { ToolCallSummary } from '../src/lib/trace-model'

function call(partial: Partial<ToolCallSummary>): ToolCallSummary {
  return {
    key: 'k',
    step: 0,
    toolName: 't',
    status: 'ok',
    args: null,
    result: null,
    error: null,
    latencyMs: null,
    attempts: 1,
    approvalOutcome: null,
    startedAt: null,
    finishedAt: null,
    decidedAt: null,
    approvalPreview: null,
    ...partial,
  }
}

describe('summarizeArgs', () => {
  it('joins up to three scalar values, naming severity-like keys', () => {
    expect(summarizeArgs({ service_name: 'payments-api', severity: 'medium', title: 'Latency', description: 'x' })).toBe(
      'payments-api · severity medium · Latency',
    )
  })
  it('skips objects/arrays and truncates long values', () => {
    expect(summarizeArgs({ widgets: [1], name: 'a'.repeat(60) })).toBe(`${'a'.repeat(47)}…`)
    expect(summarizeArgs(null)).toBe('')
  })
})

describe('artifactOf', () => {
  it('reads dashboards, incidents and memories from real result payloads', () => {
    expect(artifactOf(call({ toolName: 'create_dashboard', result: { dashboard_id: 'd1', name: 'Ops' } }))).toEqual({
      kind: 'dashboard',
      id: 'd1',
      label: 'Ops',
    })
    expect(artifactOf(call({ toolName: 'create_incident', result: { incident_id: 'INC-7', title: 'Down' } }))).toEqual({
      kind: 'incident',
      id: 'INC-7',
      label: 'Down',
    })
    expect(artifactOf(call({ toolName: 'remember', result: { memory_id: 'm1', fact: 'prefers SLOs' } }))).toEqual({
      kind: 'memory',
      id: 'm1',
      label: 'prefers SLOs',
    })
  })
  it('returns null for unfinished, denied or read-only calls', () => {
    expect(artifactOf(call({ toolName: 'create_incident', status: 'denied' }))).toBeNull()
    expect(artifactOf(call({ toolName: 'get_service_status', result: { status: 'down' } }))).toBeNull()
  })
})

describe('stalledFor', () => {
  it('flags a running run with no event for 60s or more', () => {
    expect(stalledFor(1000, 1059_000, 'running')).toBeNull()
    expect(stalledFor(1000, 1060_000, 'running')).toBe(60)
  })
  it('never flags a run waiting for approval or already finished', () => {
    expect(stalledFor(1000, 2000_000, 'pending_approval')).toBeNull()
    expect(stalledFor(1000, 2000_000, 'completed')).toBeNull()
    expect(stalledFor(null, 2000_000, 'running')).toBeNull()
  })
})
