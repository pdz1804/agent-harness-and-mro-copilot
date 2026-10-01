import { Archive, ArrowCounterClockwise, PencilSimple, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusBadge } from '../StatusBadge'
import { ApiError, api } from '../../lib/api'
import type { ChatSession } from '../../lib/api-types'

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "idle" (a session with no run yet) gets its own neutral badge; `StatusBadge`
 * only knows the run-status vocabulary. */
function SessionStatusBadge({ status }: { status: ChatSession['status'] }) {
  if (status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-zinc-600">
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
        Idle
      </span>
    )
  }
  return <StatusBadge status={status} />
}

interface SessionRowProps {
  session: ChatSession
  agentLabel: string | null
  /** Replace the row with the server's version (rename). */
  onUpdated: (session: ChatSession) => void
  /** The list must be refetched (archive/restore/delete change filter membership). */
  onChanged: () => void
}

export function SessionRow({ session, agentLabel, onUpdated, onChanged }: SessionRowProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const archived = session.archived_at !== null

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : fallback)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const startRename = () => {
    setDraft(session.title)
    setError(null)
    setRenaming(true)
  }

  const saveRename = () => {
    const title = draft.trim()
    if (!title) {
      setError('A session needs a title. Type a name or press Escape to keep the old one.')
      return
    }
    if (title === session.title) {
      setRenaming(false)
      return
    }
    void run(async () => {
      const updated = await api.updateSession(session.id, { title })
      onUpdated(updated)
      setRenaming(false)
    }, 'Could not rename the session. Try again.')
  }

  const toggleArchive = () =>
    void run(async () => {
      await api.updateSession(session.id, { archived: !archived })
      onChanged()
    }, `Could not ${archived ? 'restore' : 'archive'} the session. Try again.`)

  const remove = () =>
    void run(async () => {
      await api.deleteSession(session.id)
      onChanged()
    }, 'Could not delete the session. Try again.')

  return (
    <li className="group px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-2">
              <label htmlFor={`rename-${session.id}`} className="sr-only">
                Session title
              </label>
              <input
                id={`rename-${session.id}`}
                name="title"
                type="text"
                autoComplete="off"
                autoFocus
                value={draft}
                maxLength={200}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    saveRename()
                  } else if (e.key === 'Escape') {
                    setRenaming(false)
                    setError(null)
                  }
                }}
                className="ui-input w-full max-w-md"
              />
              <button type="button" onClick={saveRename} disabled={busy} className="ui-btn ui-btn-secondary ui-btn-sm">
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenaming(false)
                  setError(null)
                }}
                disabled={busy}
                className="ui-btn ui-btn-ghost ui-btn-sm"
              >
                Cancel
              </button>
            </div>
          ) : session.last_run_id ? (
            <Link
              to={`/sessions/${session.id}`}
              className="ui-btn-link block truncate text-[13px]"
              title={session.title}
            >
              {session.title}
            </Link>
          ) : (
            <p className="truncate text-[13px] text-zinc-700" title="No run yet, so there is nothing to open">
              {session.title}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-600 tabular-nums">
            <span className="font-data">{session.id}</span>
            <span aria-hidden="true">·</span>
            <span>{agentLabel ?? 'no agent'}</span>
            <span aria-hidden="true">·</span>
            <span>last active {formatTimestamp(session.last_active_at)}</span>
            {archived && (
              <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700">
                <Archive size={12} />
                Archived
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <SessionStatusBadge status={session.status} />
          {confirming ? (
            <span className="flex items-center gap-1">
              <span className="text-xs font-medium text-rose-700">Delete?</span>
              <button type="button" onClick={remove} disabled={busy} className="ui-btn ui-btn-danger-solid ui-btn-sm">
                {busy ? 'Deleting…' : 'Yes'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="ui-btn ui-btn-ghost ui-btn-sm">
                No
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
              {!renaming && (
                <button type="button" onClick={startRename} disabled={busy} className="ui-btn ui-btn-ghost ui-btn-sm">
                  <PencilSimple size={14} />
                  Rename
                </button>
              )}
              <button type="button" onClick={toggleArchive} disabled={busy} className="ui-btn ui-btn-ghost ui-btn-sm">
                {archived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}
                {archived ? 'Restore' : 'Archive'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setConfirming(true)
                }}
                disabled={busy}
                className="ui-btn ui-btn-ghost ui-btn-sm text-rose-600"
              >
                <Trash size={14} />
                Delete
              </button>
            </span>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-rose-700 [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </li>
  )
}
