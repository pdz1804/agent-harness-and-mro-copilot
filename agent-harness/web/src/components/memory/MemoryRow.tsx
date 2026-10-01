import { PencilSimple, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../../lib/api'
import type { Memory } from '../../lib/api-types'
import { MemoryEditor } from './MemoryEditor'

function formatDate(value: string | null): string {
  if (!value) return 'never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

interface MemoryRowProps {
  memory: Memory
  showOwner: boolean
  onUpdated: (memory: Memory) => void
  onDeleted: (id: string) => void
}

export function MemoryRow({ memory, showOwner, onUpdated, onDeleted }: MemoryRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const remove = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.deleteMemory(memory.id)
      onDeleted(memory.id)
    } catch (err: unknown) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete the memory. Try again.')
      setDeleting(false)
      setConfirming(false)
    }
  }

  if (editing) {
    return (
      <li className="px-4 py-3">
        <MemoryEditor
          idPrefix={`edit-${memory.id}`}
          initialFact={memory.fact}
          initialTags={memory.tags}
          submitLabel="Save"
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (fact, tags) => {
            const updated = await api.updateMemory(memory.id, { fact, tags })
            onUpdated(updated)
            setEditing(false)
          }}
        />
      </li>
    )
  }

  const usage =
    memory.use_count === 0
      ? 'not recalled yet'
      : `used ${memory.use_count} ${memory.use_count === 1 ? 'time' : 'times'}, last ${formatDate(memory.last_used_at)}`

  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-zinc-900 [overflow-wrap:anywhere] whitespace-pre-wrap">{memory.fact}</p>
        {memory.tags.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Tags">
            {memory.tags.map((tag) => (
              <li
                key={tag}
                className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 [overflow-wrap:anywhere]"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-600 tabular-nums">
          <span>saved {formatDate(memory.created_at)}</span>
          <span aria-hidden="true">·</span>
          <span>{usage}</span>
          <span aria-hidden="true">·</span>
          {memory.source_run_id ? (
            <Link to={`/runs/${memory.source_run_id}`} className="ui-btn-link">
              saved in a chat
            </Link>
          ) : (
            <span>added by hand</span>
          )}
          {showOwner && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                owner <span className="font-medium text-zinc-800">{memory.owner_name}</span>
              </span>
            </>
          )}
        </p>
        {deleteError && (
          <p role="alert" className="mt-1.5 text-xs text-rose-700 [overflow-wrap:anywhere]">
            {deleteError}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {confirming ? (
          <>
            <span className="text-xs font-medium text-rose-700">Delete?</span>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={deleting}
              className="ui-btn ui-btn-danger-solid ui-btn-sm"
            >
              {deleting ? 'Deleting…' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="ui-btn ui-btn-ghost ui-btn-sm"
            >
              No
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setEditing(true)} className="ui-btn ui-btn-ghost ui-btn-sm">
              <PencilSimple size={14} />
              Edit
            </button>
            <button type="button" onClick={() => setConfirming(true)} className="ui-btn ui-btn-danger ui-btn-sm">
              <Trash size={14} />
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  )
}
