import { Brain } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import type { RunMemories, UsedMemory } from '../../lib/api-types'

interface MemoryStripProps {
  runId: string
  /** Re-fetch when this changes (the number of memory tool results so far). */
  memoryCalls: number
}

function MemoryChip({ memory }: { memory: UsedMemory }) {
  return (
    <Link
      to="/memory"
      title={memory.exists ? memory.fact : `${memory.fact} (since deleted)`}
      className={`inline-flex max-w-[22rem] items-center rounded-md px-2 py-1 text-xs ring-1 ring-inset transition-colors duration-150 ${
        memory.exists
          ? 'bg-sky-50 text-sky-900 ring-sky-200 hover:bg-sky-100'
          : 'bg-zinc-50 text-zinc-500 line-through ring-zinc-200'
      }`}
    >
      <span className="truncate">{memory.fact}</span>
    </Link>
  )
}

/** The memories one turn used (`recall` results) and stored (`remember`), read
 * back from the run's own trace, linking to the Memory page. Renders nothing
 * unless the run actually touched memory. */
export function MemoryStrip({ runId, memoryCalls }: MemoryStripProps) {
  const [memories, setMemories] = useState<RunMemories | null>(null)

  useEffect(() => {
    if (memoryCalls === 0) return
    let cancelled = false
    api
      .getRunMemories(runId)
      .then((data) => {
        if (!cancelled) setMemories(data)
      })
      .catch(() => {
        /* the strip is supplementary: the tool rows already show what happened */
      })
    return () => {
      cancelled = true
    }
  }, [runId, memoryCalls])

  if (!memories || (memories.used.length === 0 && memories.saved.length === 0)) return null

  return (
    <section aria-label="Memory used in this turn" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-zinc-600">
      <Brain size={14} weight="bold" aria-hidden="true" />
      {memories.used.length > 0 && (
        <>
          <span className="font-medium">
            Used {memories.used.length} {memories.used.length === 1 ? 'memory' : 'memories'}
          </span>
          {memories.used.map((m) => (
            <MemoryChip key={m.id} memory={m} />
          ))}
        </>
      )}
      {memories.saved.length > 0 && (
        <>
          <span className="font-medium">Saved</span>
          {memories.saved.map((m) => (
            <MemoryChip key={m.id} memory={m} />
          ))}
        </>
      )}
    </section>
  )
}
