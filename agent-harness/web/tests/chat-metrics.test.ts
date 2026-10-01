import { describe, expect, it } from 'vitest'
import type { AgentEvent, RunSnapshot } from '../src/lib/api-types'
import { buildTurnMetrics, formatDuration } from '../src/lib/chat-metrics'
import { compareRuns } from '../src/lib/playground-compare'

const ev = (event_type: AgentEvent['event_type'], step: number, timestamp: number, data: Record<string, unknown> = {}): AgentEvent => ({
  run_id: 'r1',
  step,
  event_type,
  timestamp,
  latency_ms: null,
  data,
})

const history: AgentEvent[] = [
  ev('llm_decision', 1, 101, { llm_meta: { prompt_tokens: 100, completion_tokens: 20 } }),
  ev('tool_call_started', 1, 101.5, { tool_name: 'get_service_status' }),
  ev('tool_call_result', 1, 102, { tool_name: 'get_service_status' }),
  ev('llm_decision', 2, 103, { llm_meta: { prompt_tokens: 150, completion_tokens: 30 } }),
  ev('final_answer', 2, 103.2, {}),
]

describe('buildTurnMetrics', () => {
  it('sums tokens over llm_decision events and counts tools/steps', () => {
    const m = buildTurnMetrics(100, history, false)
    expect(m.promptTokens).toBe(250)
    expect(m.completionTokens).toBe(50)
    expect(m.totalTokens).toBe(300)
    expect(m.llmCalls).toBe(2)
    expect(m.toolCalls).toBe(1)
    expect(m.steps).toBe(2)
    expect(m.durationMs).toBe(3200)
  })

  it('uses "now" as the end while the run is live', () => {
    expect(buildTurnMetrics(100, history, true, 110).durationMs).toBe(10_000)
  })

  it('tolerates events with no usage metadata', () => {
    const m = buildTurnMetrics(100, [ev('llm_decision', 1, 101, {})], false)
    expect(m.totalTokens).toBe(0)
    expect(m.llmCalls).toBe(1)
  })
})

describe('formatDuration', () => {
  it('formats ms, seconds and minutes', () => {
    expect(formatDuration(420)).toBe('420 ms')
    expect(formatDuration(3200)).toBe('3.2 s')
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})

describe('compareRuns', () => {
  const snap = (final: string, hist: AgentEvent[]): RunSnapshot => ({
    run_id: 'r',
    objective: 'o',
    status: 'completed',
    started_at: 100,
    steps_taken: 2,
    final_answer: final,
    pending_approval: null,
    history: hist,
    trace_path: null,
    error: null,
    session_id: null,
    prompt_version_id: null,
    triggered_by_automation_id: null,
    owner_id: 'u',
    agent_id: null,
    skill_ids: [],
  })

  it('is empty until both runs exist', () => {
    expect(compareRuns(null, snap('x', []))).toEqual([])
  })

  it('marks the cheaper side per lower-is-better metric', () => {
    const rows = compareRuns(snap('short', history), snap('a much longer answer', [history[0], history[4]]))
    const tokens = rows.find((r) => r.label === 'Tokens')!
    expect(tokens.lowerIsBetter).toBe('b')
    const answer = rows.find((r) => r.label === 'Answer length')!
    expect(answer.a).toBe('5 chars')
    expect(answer.lowerIsBetter).toBeNull()
  })
})
