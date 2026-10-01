import { useMemo, useState } from 'react'
import type { AgentEvent, EventType } from '../lib/api-types'

/** Observability-grade span view over the same `AgentEvent` stream the chat
 * view renders — a horizontal timeline (start offset + duration bar) per
 * event, color-coded by span kind, with a click-through detail panel
 * (inputs/outputs/latency/model/tokens). Built entirely from the harness's
 * own trace data (`step`/`timestamp`/`latency_ms`/`data`); no external
 * OTel collector or backend required — see phase-07 spec part D. */

type SpanKind = 'llm_decision' | 'tool_call' | 'approval' | 'error' | 'terminal' | 'compaction' | 'guardrail'

const KIND_BY_EVENT: Record<EventType, SpanKind> = {
  llm_decision: 'llm_decision',
  llm_malformed_response: 'error',
  llm_retry_exhausted: 'error',
  tool_validation_error: 'error',
  tool_call_started: 'tool_call',
  tool_call_result: 'tool_call',
  tool_call_error: 'error',
  tool_call_timeout: 'error',
  tool_call_retry: 'tool_call',
  tool_call_retries_exhausted: 'error',
  approval_requested: 'approval',
  approval_granted: 'approval',
  approval_denied: 'approval',
  approval_timed_out: 'approval',
  final_answer: 'terminal',
  step_limit_exceeded: 'terminal',
  time_limit_exceeded: 'terminal',
  // Live-only overlay event, never persisted to history (see loop.py /
  // run_registry.py) — the waterfall only ever renders persisted events,
  // but the Record must stay exhaustive over EventType.
  llm_token_delta: 'llm_decision',
  context_compacted: 'compaction',
  guardrail_blocked: 'guardrail',
  guardrail_severity_downgraded: 'guardrail',
  skill_invoked: 'llm_decision',
  skills_assigned: 'llm_decision',
  skill_routed: 'llm_decision',
  skill_routing_failed: 'error',
  no_tools_available: 'guardrail',
  run_cancelled: 'terminal',
}

const KIND_COLOR: Record<SpanKind, string> = {
  llm_decision: 'bg-sky-500',
  tool_call: 'bg-amber-500',
  approval: 'bg-violet-500',
  error: 'bg-rose-500',
  terminal: 'bg-emerald-500',
  compaction: 'bg-fuchsia-500',
  guardrail: 'bg-pink-600',
}

const KIND_LABEL: Record<SpanKind, string> = {
  llm_decision: 'LLM call',
  tool_call: 'Tool call',
  approval: 'Approval',
  error: 'Error',
  terminal: 'Terminal',
  compaction: 'Context compacted',
  guardrail: 'Guardrail',
}

interface Span {
  event: AgentEvent
  index: number
  kind: SpanKind
  startMs: number
  durationMs: number
  label: string
}

function toolLabel(event: AgentEvent): string {
  const name = typeof event.data.tool_name === 'string' ? event.data.tool_name : undefined
  return name ?? event.event_type
}

function spanLabel(event: AgentEvent): string {
  switch (event.event_type) {
    case 'llm_decision':
      return event.data.action === 'tool_call'
        ? `LLM -> ${String(event.data.tool_name ?? 'tool')}`
        : 'LLM -> final_answer'
    case 'tool_call_started':
      return `${toolLabel(event)} started`
    case 'tool_call_result':
      return `${toolLabel(event)} succeeded`
    case 'tool_call_error':
      return `${toolLabel(event)} error`
    case 'tool_call_timeout':
      return `${toolLabel(event)} timed out`
    case 'tool_call_retry':
      return `${toolLabel(event)} retrying`
    case 'tool_call_retries_exhausted':
      return `${toolLabel(event)} retries exhausted`
    case 'llm_malformed_response':
      return 'LLM malformed response'
    case 'llm_retry_exhausted':
      return 'LLM retries exhausted'
    case 'tool_validation_error':
      return `${toolLabel(event)} validation error`
    case 'step_limit_exceeded':
      return 'Step limit exceeded'
    case 'time_limit_exceeded':
      return 'Time limit exceeded'
    case 'approval_requested':
    case 'approval_granted':
    case 'approval_denied':
    case 'approval_timed_out':
      return `Approval: ${toolLabel(event)}`
    case 'final_answer':
      return 'Final answer'
    case 'context_compacted': {
      const before = String(event.data.tokens_before ?? '?')
      const after = String(event.data.tokens_after ?? '?')
      return `Context compacted (${before} -> ${after} tokens)`
    }
    case 'guardrail_blocked':
      return `Guardrail blocked: ${String(event.data.matched_pattern ?? '?')}`
    case 'guardrail_severity_downgraded':
      return `Guardrail: severity ${String(event.data.proposed_severity ?? '?')} -> ${String(
        event.data.downgraded_to ?? '?',
      )}`
    default:
      return event.event_type
  }
}

function buildSpans(events: AgentEvent[]): Span[] {
  if (events.length === 0) return []
  const t0 = Math.min(...events.map((e) => e.timestamp))
  return events.map((event, index) => {
    const durationMs = event.latency_ms ?? 0
    const endMs = (event.timestamp - t0) * 1000
    const startMs = Math.max(0, endMs - durationMs)
    return {
      event,
      index,
      kind: KIND_BY_EVENT[event.event_type] ?? 'terminal',
      startMs,
      durationMs: Math.max(durationMs, 2),
      label: spanLabel(event),
    }
  })
}

export function TraceWaterfall({ events }: { events: AgentEvent[] }) {
  const spans = useMemo(() => buildSpans(events), [events])
  const [selected, setSelected] = useState<Span | null>(null)

  if (spans.length === 0) {
    return <p className="text-sm text-zinc-500">No spans recorded yet.</p>
  }

  const totalMs = Math.max(...spans.map((s) => s.startMs + s.durationMs), 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        {(Object.keys(KIND_LABEL) as SpanKind[]).map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${KIND_COLOR[kind]}`} />
            {KIND_LABEL[kind]}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <div className="min-w-[560px] space-y-1">
          {spans.map((span) => {
            const leftPct = (span.startMs / totalMs) * 100
            const widthPct = Math.max((span.durationMs / totalMs) * 100, 0.6)
            const isSelected = selected?.index === span.index
            return (
              <button
                key={span.index}
                type="button"
                onClick={() => setSelected(isSelected ? null : span)}
                className={`group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition ${
                  isSelected ? 'bg-zinc-200/70' : 'hover:bg-zinc-100'
                }`}
              >
                <span className="w-56 shrink-0 truncate font-data text-xs text-zinc-600">
                  step {span.event.step} · {span.label}
                </span>
                <span className="relative h-3 flex-1 rounded bg-zinc-200">
                  <span
                    className={`absolute top-0 h-3 min-w-[3px] rounded ${KIND_COLOR[span.kind]}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-data text-xs text-zinc-500">
                  {span.durationMs >= 1 ? `${span.durationMs.toFixed(0)}ms` : '—'}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {selected && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">{selected.label}</h3>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium text-white ${KIND_COLOR[selected.kind]}`}>
              {KIND_LABEL[selected.kind]}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-500 sm:grid-cols-4">
            <div>
              <dt className="text-zinc-500">Step</dt>
              <dd className="font-data text-zinc-700">{selected.event.step}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Start offset</dt>
              <dd className="font-data text-zinc-700">{selected.startMs.toFixed(0)}ms</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Duration</dt>
              <dd className="font-data text-zinc-700">
                {selected.event.latency_ms !== null ? `${selected.event.latency_ms.toFixed(1)}ms` : 'n/a'}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Event type</dt>
              <dd className="font-data text-zinc-700">{selected.event.event_type}</dd>
            </div>
          </dl>
          <pre className="font-data mt-3 max-h-64 overflow-auto rounded-md bg-zinc-50 p-3 text-xs text-zinc-600 ring-1 ring-zinc-200">
            {JSON.stringify(selected.event.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
