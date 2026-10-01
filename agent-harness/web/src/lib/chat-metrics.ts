import type { AgentEvent } from './api-types'

export interface TurnMetrics {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  llmCalls: number
  toolCalls: number
  steps: number
  /** Wall-clock from run start to its last recorded event (or `now` while live), in ms. */
  durationMs: number
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Per-message metrics derived from a run's own persisted events — the same
 * `llm_meta` token counts the token badge aggregates server-side, here
 * scoped to one chat turn. Pure; `nowSeconds` is injected for tests. */
export function buildTurnMetrics(
  startedAt: number,
  history: AgentEvent[],
  live: boolean,
  nowSeconds: number = Date.now() / 1000,
): TurnMetrics {
  let promptTokens = 0
  let completionTokens = 0
  let llmCalls = 0
  let toolCalls = 0
  let steps = 0
  let lastTimestamp = startedAt
  for (const event of history) {
    lastTimestamp = Math.max(lastTimestamp, event.timestamp)
    steps = Math.max(steps, event.step)
    if (event.event_type === 'llm_decision') {
      llmCalls += 1
      const meta = event.data.llm_meta
      if (meta && typeof meta === 'object') {
        promptTokens += numberOf((meta as Record<string, unknown>).prompt_tokens)
        completionTokens += numberOf((meta as Record<string, unknown>).completion_tokens)
      }
    } else if (event.event_type === 'tool_call_started') {
      toolCalls += 1
    }
  }
  const end = live ? nowSeconds : lastTimestamp
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    llmCalls,
    toolCalls,
    steps,
    durationMs: Math.max(0, Math.round((end - startedAt) * 1000)),
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}
