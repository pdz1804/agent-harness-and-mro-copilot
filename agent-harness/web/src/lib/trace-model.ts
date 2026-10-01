/** Pure event-grouping logic for the chat workspace inspector (phase 05).
 * No React, no DOM — takes the same `AgentEvent[]` the SSE stream/snapshot
 * already exposes and derives:
 *  - `steps`: events grouped by `step`
 *  - `toolCalls`: one `ToolCallSummary` per (step, tool_name) pair, built by
 *    correlating `tool_call_started` with whichever terminal event follows
 *    it for that same step+tool (`tool_call_result` / `tool_call_error` /
 *    `tool_call_timeout` / `tool_call_retries_exhausted` / a bare
 *    `approval_denied` with no started event at all, or `tool_validation_error`
 *    which never has a `tool_call_started` counterpart).
 *  - `categories`: which coarse category each event belongs to, for the
 *    Timeline tab's filter chips.
 */
import type { AgentEvent, EventType } from './api-types'

/** `awaiting_approval`: an approval-gated call paused for a human decision
 * (between `approval_requested` and `approval_granted`/`approval_denied`). */
export type ToolCallStatus = 'awaiting_approval' | 'started' | 'ok' | 'retry' | 'timeout' | 'error' | 'denied' | 'invalid'

export interface ToolCallSummary {
  /** Stable key: `${step}:${toolName}:${firstSeenIndex}` — unique even when
   * the same tool is called twice in one step (rare, but not impossible if a
   * future loop change allows parallel calls). */
  key: string
  step: number
  toolName: string
  status: ToolCallStatus
  args: Record<string, unknown> | null
  result: unknown
  error: string | null
  latencyMs: number | null
  attempts: number
  approvalOutcome: 'granted' | 'denied' | null
  startedAt: number | null
  finishedAt: number | null
  /** Timestamp of the approval decision (granted or denied), if any. */
  decidedAt: number | null
  /** The dry-run preview the tool attached to its approval request (e.g. the
   * widgets + live sample rows a `create_dashboard` call will create). */
  approvalPreview: unknown
}

export type EventCategory = 'routing' | 'llm' | 'tools' | 'approvals' | 'guardrails' | 'limits' | 'other'

export const CATEGORY_BY_EVENT: Record<EventType, EventCategory> = {
  llm_decision: 'llm',
  llm_malformed_response: 'llm',
  llm_retry_exhausted: 'llm',
  llm_token_delta: 'llm',
  tool_validation_error: 'tools',
  tool_call_started: 'tools',
  tool_call_result: 'tools',
  tool_call_error: 'tools',
  tool_call_timeout: 'tools',
  tool_call_retry: 'tools',
  tool_call_retries_exhausted: 'tools',
  approval_requested: 'approvals',
  approval_granted: 'approvals',
  approval_denied: 'approvals',
  approval_timed_out: 'approvals',
  final_answer: 'other',
  step_limit_exceeded: 'limits',
  time_limit_exceeded: 'limits',
  context_compacted: 'other',
  guardrail_blocked: 'guardrails',
  guardrail_severity_downgraded: 'guardrails',
  skill_invoked: 'routing',
  skills_assigned: 'routing',
  skill_routed: 'routing',
  skill_routing_failed: 'routing',
  no_tools_available: 'routing',
  run_cancelled: 'limits',
}

export function categorize(event: AgentEvent): EventCategory {
  return CATEGORY_BY_EVENT[event.event_type] ?? 'other'
}

export function groupByStep(events: AgentEvent[]): Map<number, AgentEvent[]> {
  const steps = new Map<number, AgentEvent[]>()
  for (const event of events) {
    const list = steps.get(event.step)
    if (list) list.push(event)
    else steps.set(event.step, [event])
  }
  return steps
}

function toolNameOf(event: AgentEvent): string | null {
  const name = event.data.tool_name
  return typeof name === 'string' ? name : null
}

function asArgs(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Correlates tool-call lifecycle events into one card per call. Handles:
 * retry-then-success (keeps the final outcome, counts attempts), timeout,
 * validation error with no `tool_call_started` at all (args come straight
 * off the validation-error event), approval denial (no execution ever
 * happens), and multiple distinct tool calls within the same step (each
 * gets its own summary, matched in event order so interleaving never mixes
 * two calls' data together). */
export function buildToolCalls(events: AgentEvent[]): ToolCallSummary[] {
  // Open calls per (step, tool) in the order they started, so that if the
  // same tool is called twice in one step, results are matched FIFO.
  const open = new Map<string, ToolCallSummary[]>()
  const ordered: ToolCallSummary[] = []

  const keyOf = (step: number, tool: string) => `${step}:${tool}`

  const pushOpen = (summary: ToolCallSummary) => {
    const k = keyOf(summary.step, summary.toolName)
    const list = open.get(k)
    if (list) list.push(summary)
    else open.set(k, [summary])
    ordered.push(summary)
  }

  const takeOpen = (step: number, tool: string): ToolCallSummary | undefined => {
    const k = keyOf(step, tool)
    const list = open.get(k)
    return list?.shift()
  }

  // Approval placeholders that were requested but have not started executing.
  const awaitingExecution = new Set<ToolCallSummary>()
  let seq = 0
  for (const event of events) {
    const tool = toolNameOf(event)
    if (!tool) continue

    switch (event.event_type) {
      case 'tool_call_started': {
        // An approval-gated call already has an open placeholder (opened at
        // `approval_requested`, marked granted). Execution starting is the
        // same call moving on, not a second call — adopt the placeholder so
        // the result attaches to it and no phantom "running" row is left.
        const approved = open
          .get(keyOf(event.step, tool))
          ?.find((c) => c.approvalOutcome === 'granted' && awaitingExecution.has(c))
        if (approved) {
          awaitingExecution.delete(approved)
          approved.status = 'started'
          approved.args = asArgs(event.data.args) ?? approved.args
          if (typeof event.data.attempt === 'number') approved.attempts = event.data.attempt
          break
        }
        pushOpen({
          key: `${event.step}:${tool}:${seq++}`,
          step: event.step,
          toolName: tool,
          status: 'started',
          args: asArgs(event.data.args),
          result: null,
          error: null,
          latencyMs: null,
          attempts: typeof event.data.attempt === 'number' ? event.data.attempt : 1,
          approvalOutcome: null,
          startedAt: event.timestamp,
          finishedAt: null,
          decidedAt: null,
          approvalPreview: null,
        })
        break
      }
      case 'approval_requested': {
        // Always precedes tool_call_started for approval-gated tools, but
        // if denied, tool_call_started never fires — open a placeholder
        // now so the denial below has something to attach to.
        const placeholder: ToolCallSummary = {
          key: `${event.step}:${tool}:${seq++}`,
          step: event.step,
          toolName: tool,
          status: 'awaiting_approval',
          args: asArgs(event.data.args),
          result: null,
          error: null,
          latencyMs: null,
          attempts: 1,
          approvalOutcome: null,
          startedAt: event.timestamp,
          finishedAt: null,
          decidedAt: null,
          approvalPreview: event.data.preview ?? null,
        }
        awaitingExecution.add(placeholder)
        pushOpen(placeholder)
        break
      }
      case 'approval_granted': {
        const list = open.get(keyOf(event.step, tool))
        const call = list?.find((c) => c.status === 'awaiting_approval') ?? list?.[0]
        if (call) {
          call.approvalOutcome = 'granted'
          call.decidedAt = event.timestamp
          if (call.status === 'awaiting_approval') call.status = 'started'
        }
        break
      }
      case 'approval_denied': {
        const call = takeOpen(event.step, tool)
        if (call) {
          awaitingExecution.delete(call)
          call.approvalOutcome = 'denied'
          call.status = 'denied'
          call.finishedAt = event.timestamp
          call.decidedAt = event.timestamp
        }
        break
      }
      case 'approval_timed_out': {
        // Nobody decided in time: the call never ran and the run ended.
        const call = takeOpen(event.step, tool)
        if (call) {
          awaitingExecution.delete(call)
          call.status = 'timeout'
          call.error = 'No approval decision in time; the action was not run.'
          call.finishedAt = event.timestamp
        }
        break
      }
      case 'tool_call_retry': {
        const list = open.get(keyOf(event.step, tool))
        const call = list?.[0]
        if (call) {
          call.status = 'retry'
          call.attempts = typeof event.data.next_attempt === 'number' ? event.data.next_attempt : call.attempts + 1
        }
        break
      }
      case 'tool_call_result': {
        const call = takeOpen(event.step, tool)
        if (call) {
          call.status = 'ok'
          call.result = event.data.result ?? event.data.output ?? null
          call.latencyMs = event.latency_ms
          call.finishedAt = event.timestamp
          if (typeof event.data.attempt === 'number') call.attempts = event.data.attempt
        }
        break
      }
      case 'tool_call_error': {
        const call = takeOpen(event.step, tool)
        if (call) {
          call.status = 'error'
          call.error = typeof event.data.error === 'string' ? event.data.error : 'error'
          call.latencyMs = event.latency_ms
          call.finishedAt = event.timestamp
        }
        break
      }
      case 'tool_call_timeout': {
        const list = open.get(keyOf(event.step, tool))
        const call = list?.[0]
        if (call) {
          call.status = 'timeout'
          call.error = `timed out after ${String(event.data.timeout_seconds ?? '?')}s`
          call.finishedAt = event.timestamp
        }
        break
      }
      case 'tool_call_retries_exhausted': {
        const call = takeOpen(event.step, tool)
        if (call) {
          call.status = 'error'
          call.error = `gave up after ${String(event.data.attempts ?? '?')} attempts`
          call.finishedAt = event.timestamp
        }
        break
      }
      case 'tool_validation_error': {
        // Never has a tool_call_started counterpart — the call is rejected
        // before execution.
        ordered.push({
          key: `${event.step}:${tool}:${seq++}`,
          step: event.step,
          toolName: tool,
          status: 'invalid',
          args: asArgs(event.data.args),
          result: null,
          error: typeof event.data.error === 'string' ? event.data.error : 'invalid arguments',
          latencyMs: event.latency_ms,
          attempts: 1,
          approvalOutcome: null,
          startedAt: event.timestamp,
          finishedAt: event.timestamp,
          decidedAt: null,
          approvalPreview: null,
        })
        break
      }
      default:
        break
    }
  }

  return ordered
}

export interface SkillRoutedInfo {
  step: number
  candidates: string[]
  selected: string[]
  rationale: string
  confidence: number
}

/** Reasoning-tab data: the router's own stated rationale plus the model's
 * pre-tool-call "thoughts" from `llm_decision` events. Deliberately does NOT
 * fabricate anything the provider didn't return — see `hasHiddenReasoning`. */
export function buildReasoning(events: AgentEvent[]): {
  routed: SkillRoutedInfo[]
  decisions: { step: number; text: string | null; action: string | null }[]
} {
  const routed: SkillRoutedInfo[] = []
  const decisions: { step: number; text: string | null; action: string | null }[] = []
  for (const event of events) {
    if (event.event_type === 'skill_routed') {
      routed.push({
        step: event.step,
        candidates: Array.isArray(event.data.candidates) ? (event.data.candidates as string[]) : [],
        selected: Array.isArray(event.data.selected) ? (event.data.selected as string[]) : [],
        rationale: typeof event.data.rationale === 'string' ? event.data.rationale : '',
        confidence: typeof event.data.confidence === 'number' ? event.data.confidence : 0,
      })
    } else if (event.event_type === 'llm_decision') {
      const text = typeof event.data.rationale === 'string' ? event.data.rationale : null
      const action = typeof event.data.action === 'string' ? event.data.action : null
      decisions.push({ step: event.step, text, action })
    }
  }
  return { routed, decisions }
}
