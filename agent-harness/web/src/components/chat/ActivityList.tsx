import { CaretRight } from '@phosphor-icons/react'
import { useState } from 'react'
import type { AgentEvent, EventType } from '../../lib/api-types'
import { formatDuration } from '../../lib/chat-metrics'
import { EVENT_META, summarize } from '../TraceTimeline'
import { JsonTree } from '../ui/JsonTree'

type Tone = 'running' | 'attention' | 'success' | 'danger' | 'muted'

// Same tile palette as ToolCallCard, so activity rows and tool rows read as one list.
const TILE: Record<Tone, string> = {
  running: 'bg-sky-50 text-sky-600 ring-sky-200',
  attention: 'bg-amber-50 text-amber-600 ring-amber-200',
  success: 'bg-emerald-50 text-emerald-600 ring-emerald-200',
  danger: 'bg-rose-50 text-rose-600 ring-rose-200',
  muted: 'bg-zinc-100 text-zinc-500 ring-zinc-200',
}

const TONE: Partial<Record<EventType, Tone>> = {
  llm_decision: 'running',
  tool_call_started: 'running',
  skill_routed: 'running',
  skill_invoked: 'running',
  skills_assigned: 'running',
  tool_call_result: 'success',
  approval_granted: 'success',
  final_answer: 'success',
  approval_requested: 'attention',
  approval_timed_out: 'attention',
  tool_validation_error: 'attention',
  llm_malformed_response: 'attention',
  tool_call_retry: 'attention',
  tool_call_timeout: 'attention',
  step_limit_exceeded: 'attention',
  time_limit_exceeded: 'attention',
  skill_routing_failed: 'attention',
  guardrail_severity_downgraded: 'attention',
  tool_call_error: 'danger',
  tool_call_retries_exhausted: 'danger',
  llm_retry_exhausted: 'danger',
  approval_denied: 'danger',
  guardrail_blocked: 'danger',
}

function ActivityRow({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false)
  const meta = EVENT_META[event.event_type]
  const summary = summarize(event)
  const hasData = Object.keys(event.data).length > 0
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasData}
        aria-expanded={hasData ? open : undefined}
        className="group flex min-h-9 w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors duration-150 enabled:hover:bg-zinc-950/[0.025] disabled:cursor-default"
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ring-inset [&>svg]:h-3 [&>svg]:w-3 ${TILE[TONE[event.event_type] ?? 'muted']}`}
          aria-hidden="true"
        >
          {meta.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-zinc-800">{meta.label}</span>
          {summary && <span className="text-zinc-500"> · {summary}</span>}
        </span>
        <span className="font-data shrink-0 text-[11px] text-zinc-400 tabular-nums">step {event.step}</span>
        {event.latency_ms !== null && (
          <span className="font-data w-12 shrink-0 text-right text-[11.5px] text-zinc-500 tabular-nums">
            {formatDuration(Math.round(event.latency_ms))}
          </span>
        )}
        <CaretRight
          size={11}
          weight="bold"
          className={`shrink-0 text-zinc-300 transition-transform duration-200 group-hover:text-zinc-500 ${open ? 'rotate-90' : ''} ${hasData ? '' : 'invisible'}`}
        />
      </button>
      {open && hasData && (
        <div className="animate-fade px-3 pb-3 pl-[2.625rem]">
          <JsonTree value={event.data} label="Event data" />
        </div>
      )}
    </li>
  )
}

/** The agent's activity for one turn as compact rows (glyph · what happened ·
 * step · latency), in the same visual language as `ToolCallCard`. Each row
 * expands to its event data. */
export function ActivityList({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) return <p className="px-1 text-[13px] text-zinc-500">No activity recorded yet.</p>
  return (
    <ol
      className="divide-y divide-[var(--color-line)] overflow-hidden rounded-xl bg-white shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)]"
      aria-label="Agent activity"
    >
      {events.map((event, i) => (
        // Run history is append-only, so a positional key is stable.
        <ActivityRow key={i} event={event} />
      ))}
    </ol>
  )
}
