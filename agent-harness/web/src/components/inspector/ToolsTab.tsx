import { useMemo } from 'react'
import type { AgentEvent } from '../../lib/api-types'
import { buildToolCalls } from '../../lib/trace-model'
import { ToolCallCard } from '../chat/ToolCallCard'

/** The inspector's Tools tab: the same `ToolCallCard` the thread uses,
 * expanded, with the focused call highlighted. */
export function ToolsTab({ events, focusedKey }: { events: AgentEvent[]; focusedKey: string | null }) {
  const calls = useMemo(() => buildToolCalls(events), [events])

  if (calls.length === 0) {
    return <p className="text-sm text-zinc-500">No tool calls in this run yet.</p>
  }

  return (
    <div className="space-y-2">
      {calls.map((call) => (
        <ToolCallCard key={call.key} call={call} defaultOpen highlighted={call.key === focusedKey} />
      ))}
    </div>
  )
}
