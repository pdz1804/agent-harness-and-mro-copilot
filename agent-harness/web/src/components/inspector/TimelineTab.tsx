import { useMemo, useState } from 'react'
import type { AgentEvent } from '../../lib/api-types'
import { categorize, type EventCategory } from '../../lib/trace-model'
import { TraceTimeline } from '../TraceTimeline'

const CATEGORIES: EventCategory[] = ['routing', 'llm', 'tools', 'approvals', 'guardrails', 'limits', 'other']

const CATEGORY_LABEL: Record<EventCategory, string> = {
  routing: 'Routing',
  llm: 'LLM',
  tools: 'Tools',
  approvals: 'Approvals',
  guardrails: 'Guardrails',
  limits: 'Limits',
  other: 'Other',
}

export function TimelineTab({ events }: { events: AgentEvent[] }) {
  const [active, setActive] = useState<Set<EventCategory>>(new Set(CATEGORIES))

  const toggle = (cat: EventCategory) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const filtered = useMemo(() => events.filter((e) => active.has(categorize(e))), [events, active])

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => toggle(cat)}
            className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition ${
              active.has(cat) ? 'bg-sky-50 text-sky-700 ring-sky-200' : 'bg-zinc-50 text-zinc-500 ring-zinc-200'
            }`}
          >
            {CATEGORY_LABEL[cat]}
          </button>
        ))}
      </div>
      <TraceTimeline events={filtered} />
    </div>
  )
}
