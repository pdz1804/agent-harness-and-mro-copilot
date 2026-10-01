import {
  ArrowClockwise,
  Brain,
  CheckCircle,
  Clock,
  FlagCheckered,
  Hourglass,
  Prohibit,
  ShieldCheck,
  ShieldWarning,
  Scissors,
  Warning,
  WarningCircle,
  Wrench,
  XCircle,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { AgentEvent, EventType } from '../lib/api-types'

interface EventMeta {
  icon: ReactNode
  dotClassName: string
  label: string
}

const ICON_SIZE = 14

export const EVENT_META: Record<EventType, EventMeta> = {
  llm_decision: {
    icon: <Brain size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-sky-100 text-sky-700 ring-1 ring-sky-300',
    label: 'LLM decision',
  },
  llm_malformed_response: {
    icon: <Warning size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Malformed LLM response',
  },
  llm_retry_exhausted: {
    icon: <XCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-rose-100 text-rose-700 ring-1 ring-rose-300',
    label: 'LLM retries exhausted',
  },
  tool_validation_error: {
    icon: <WarningCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Invalid tool arguments',
  },
  tool_call_started: {
    icon: <Wrench size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-300',
    label: 'Tool call started',
  },
  tool_call_result: {
    icon: <CheckCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300',
    label: 'Tool call result',
  },
  tool_call_error: {
    icon: <XCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-rose-100 text-rose-700 ring-1 ring-rose-300',
    label: 'Tool call error',
  },
  tool_call_timeout: {
    icon: <Clock size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-orange-100 text-orange-700 ring-1 ring-orange-300',
    label: 'Tool call timed out',
  },
  tool_call_retry: {
    icon: <ArrowClockwise size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Retrying tool call',
  },
  tool_call_retries_exhausted: {
    icon: <XCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-rose-100 text-rose-700 ring-1 ring-rose-300',
    label: 'Tool retries exhausted',
  },
  approval_requested: {
    icon: <ShieldWarning size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Approval requested',
  },
  approval_granted: {
    icon: <ShieldCheck size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300',
    label: 'Approval granted',
  },
  approval_denied: {
    icon: <XCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-rose-100 text-rose-700 ring-1 ring-rose-300',
    label: 'Approval denied',
  },
  approval_timed_out: {
    icon: <Clock size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Approval timed out',
  },
  final_answer: {
    icon: <FlagCheckered size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300',
    label: 'Final answer',
  },
  step_limit_exceeded: {
    icon: <Hourglass size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-orange-100 text-orange-700 ring-1 ring-orange-300',
    label: 'Step limit exceeded',
  },
  time_limit_exceeded: {
    icon: <Hourglass size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-orange-100 text-orange-700 ring-1 ring-orange-300',
    label: 'Time limit exceeded',
  },
  // Live-only overlay event (see loop.py::_decide / run_registry.py) —
  // never appended to persisted history, so this row never actually
  // renders. Present only to keep the Record exhaustive over EventType.
  llm_token_delta: {
    icon: <Brain size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-sky-100 text-sky-700 ring-1 ring-sky-300',
    label: 'Token delta',
  },
  context_compacted: {
    icon: <Scissors size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-violet-100 text-violet-700 ring-1 ring-violet-300',
    label: 'Context compacted',
  },
  guardrail_blocked: {
    icon: <Prohibit size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-300',
    label: 'Blocked by guardrail',
  },
  guardrail_severity_downgraded: {
    icon: <ShieldWarning size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-fuchsia-100 text-fuchsia-700 ring-1 ring-fuchsia-300',
    label: 'Severity downgraded by guardrail',
  },
  run_cancelled: {
    icon: <Prohibit size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-300',
    label: 'Run stopped',
  },
  skill_invoked: {
    icon: <Wrench size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-sky-100 text-sky-700 ring-1 ring-sky-300',
    label: 'Skill invoked (/slash)',
  },
  skills_assigned: {
    icon: <Wrench size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-sky-100 text-sky-700 ring-1 ring-sky-300',
    label: 'Skills assigned',
  },
  skill_routed: {
    icon: <Brain size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-violet-100 text-violet-700 ring-1 ring-violet-300',
    label: 'Skill routed (auto)',
  },
  skill_routing_failed: {
    icon: <Warning size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300',
    label: 'Skill routing failed',
  },
  no_tools_available: {
    icon: <WarningCircle size={ICON_SIZE} weight="fill" />,
    dotClassName: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-300',
    label: 'No tools available',
  },
}

function formatSeconds(value: unknown): string {
  if (typeof value !== 'number') return '?'
  return value >= 60 && value % 60 === 0 ? `${value / 60} min` : `${value}s`
}

export function summarize(event: AgentEvent): string {
  const d = event.data
  const toolName = typeof d.tool_name === 'string' ? d.tool_name : undefined
  switch (event.event_type) {
    case 'llm_decision': {
      const base =
        d.action === 'final_answer' ? 'Decided to answer.' : `Decided to call ${String(d.tool_name ?? 'a tool')}.`
      const meta = d.llm_meta as Record<string, unknown> | undefined
      if (!meta) return base
      const model = typeof meta.model === 'string' ? meta.model : undefined
      const tokens = typeof meta.total_tokens === 'number' ? meta.total_tokens : undefined
      const parts = [model, tokens !== undefined ? `${tokens} tokens` : undefined].filter(Boolean)
      return parts.length ? `${base} (${parts.join(', ')})` : base
    }
    case 'tool_call_started':
      return `${toolName ?? 'tool'} — attempt ${String(d.attempt ?? 1)}`
    case 'tool_call_result':
      return `${toolName ?? 'tool'} succeeded (attempt ${String(d.attempt ?? 1)})`
    case 'tool_call_error':
      return `${toolName ?? 'tool'}: ${String(d.error ?? 'error')}`
    case 'tool_call_timeout':
      return `${toolName ?? 'tool'} timed out after ${String(d.timeout_seconds ?? '?')}s`
    case 'tool_call_retry':
      return `${toolName ?? 'tool'} — retrying (attempt ${String(d.next_attempt ?? '?')})`
    case 'tool_call_retries_exhausted':
      return `${toolName ?? 'tool'} — gave up after ${String(d.attempts ?? '?')} attempts`
    case 'tool_validation_error':
      return `${toolName ?? 'tool'}: ${String(d.error ?? 'invalid arguments')}`
    case 'approval_requested':
    case 'approval_granted':
    case 'approval_denied':
      return String(toolName ?? 'tool')
    case 'approval_timed_out':
      return `${toolName ?? 'tool'}: no decision within ${formatSeconds(d.timeout_seconds)}`
    case 'run_cancelled':
      return d.reason === 'approval_timeout' ? 'Nobody approved or denied in time.' : 'Stopped by user.'
    case 'final_answer':
      return String(d.final_answer ?? '')
    case 'step_limit_exceeded':
      return `Hit ${String(d.limit ?? '?')} step limit.`
    case 'time_limit_exceeded':
      return `Hit ${String(d.limit_seconds ?? '?')}s wall-clock limit.`
    case 'llm_malformed_response':
      return `Attempt ${String(d.attempt ?? '?')}: ${String(d.error ?? 'malformed')}`
    case 'llm_retry_exhausted':
      return `Gave up after ${String(d.attempts ?? '?')} attempts.`
    case 'context_compacted':
      return `Summarized ${String(d.messages_summarized ?? '?')} message(s): ${String(
        d.tokens_before ?? '?',
      )} -> ${String(d.tokens_after ?? '?')} tokens (budget ${String(d.token_budget ?? '?')}).`
    case 'guardrail_blocked':
      return `"${String(d.guardrail_name ?? 'guardrail')}" matched pattern "${String(d.matched_pattern ?? '?')}".`
    case 'guardrail_severity_downgraded':
      return `${String(d.proposed_severity ?? '?')} -> ${String(d.downgraded_to ?? '?')} (${String(
        d.guardrail_name ?? 'guardrail',
      )}: ${String(d.reason ?? '')})`
    default:
      return ''
  }
}

function EventRow({ event }: { event: AgentEvent }) {
  const meta = EVENT_META[event.event_type]
  const summary = summarize(event)

  return (
    <li className="relative flex gap-3 pb-6 last:pb-0">
      <span className="absolute top-6 bottom-0 left-[11px] w-px bg-zinc-200 last:hidden" aria-hidden="true" />
      <span
        className={`z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.dotClassName}`}
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-medium text-zinc-500 ">
            step {event.step}
          </span>
          <span className="text-sm font-medium text-zinc-800">{meta.label}</span>
          {event.latency_ms !== null && (
            <span className="font-data text-xs text-zinc-500">{event.latency_ms.toFixed(1)}ms</span>
          )}
        </div>
        {summary && <p className="mt-0.5 truncate text-sm text-zinc-600">{summary}</p>}
        {Object.keys(event.data).length > 0 && (
          <details className="mt-1 group">
            <summary className="cursor-pointer text-xs text-zinc-500 select-none hover:text-zinc-700">
              raw event data
            </summary>
            <pre className="font-data mt-1 overflow-x-auto rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 ring-1 ring-zinc-200">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </li>
  )
}

export function TraceTimeline({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-zinc-500">No steps recorded yet.</p>
  }
  return (
    <ol className="mt-2">
      {events.map((event, i) => (
        // Events within a run are append-only and never reordered/removed,
        // so a stable positional key is safe here.
        <EventRow key={i} event={event} />
      ))}
    </ol>
  )
}
