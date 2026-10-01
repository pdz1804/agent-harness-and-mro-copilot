import { ChatsCircle, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { SessionFilterBar } from '../components/sessions/SessionFilterBar'
import { SessionRow } from '../components/sessions/SessionRow'
import { PageHeader } from '../components/ui/PageHeader'
import { ApiError, api } from '../lib/api'
import type { Agent, ChatSession } from '../lib/api-types'
import {
  EMPTY_FILTER_STATE,
  type SessionFilterState,
  buildFilters,
  countLabel,
  hasActiveFilters,
} from '../lib/session-filters'

const SEARCH_DEBOUNCE_MS = 250
const POLL_INTERVAL_MS = 4_000

/** Sessions list with live status. `GET /sessions` recomputes status
 * server-side on every call, so a short poll keeps it current with no
 * client-side state to go stale. Inline rename state lives inside each row
 * (keyed by session id), so a poll replacing the list never resets a draft. */
export function SessionsPage() {
  const [filters, setFilters] = useState<SessionFilterState>(EMPTY_FILTER_STATE)
  const [searchInput, setSearchInput] = useState('')
  const [sessions, setSessions] = useState<ChatSession[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setFilters((prev) => (prev.q === searchInput ? prev : { ...prev, q: searchInput })), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    api
      .listAgents()
      .then((data) => {
        if (!cancelled) setAgents(data)
      })
      .catch(() => {
        /* Agent names are a nicety: rows fall back to the raw agent id. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const active = hasActiveFilters(filters)
  const apiFilters = useMemo(() => buildFilters(filters), [filters])
  const filterKey = JSON.stringify(apiFilters)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      const filtered = api.listSessions(apiFilters)
      // The "of N" denominator is every session the user can see, ignoring filters.
      const everything = active ? api.listSessions({ archived: 'include' }) : null
      Promise.all([filtered, everything])
        .then(([data, all]) => {
          if (cancelled) return
          setSessions(data)
          setTotal(all ? all.length : data.length)
          setError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setError(err instanceof ApiError ? err.message : 'Failed to load sessions.')
        })
    }
    load()
    const interval = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // filterKey is the serialised apiFilters, so it stands in for them here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, active, refreshToken])

  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])

  const patch = (change: Partial<SessionFilterState>) => setFilters((prev) => ({ ...prev, ...change }))
  const clear = () => {
    setSearchInput('')
    setFilters(EMPTY_FILTER_STATE)
  }
  const retry = () => {
    setError(null)
    setSessions(null)
    setRefreshToken((n) => n + 1)
  }
  const reload = () => setRefreshToken((n) => n + 1)

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sessions"
        description="Every chat you have started, with its live status. Search, filter, rename, archive or delete them here."
        actions={
          <Link to="/chat" className="ui-btn ui-btn-primary">
            <Plus size={14} weight="bold" />
            New chat
          </Link>
        }
      />

      <div className="mt-4">
        <SessionFilterBar
          searchInput={searchInput}
          filters={filters}
          agents={agents}
          canClear={active || searchInput !== ''}
          onSearchInput={setSearchInput}
          onChange={patch}
          onClear={clear}
        />
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorBanner message={`${error} Check that the backend is running, then retry.`} onRetry={retry} />
        ) : sessions === null ? (
          <div className="space-y-2" role="status" aria-label="Loading sessions">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          active ? (
            <EmptyState
              icon={<MagnifyingGlass size={32} weight="duotone" />}
              title="No sessions match your filters"
              description="Loosen the search, widen the date range, or include archived sessions."
              action={
                <button type="button" onClick={clear} className="ui-btn ui-btn-secondary ui-btn-sm">
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<ChatsCircle size={32} weight="duotone" />}
              title="No sessions yet"
              description="Start a chat with an agent and it will appear here with its live status."
              action={
                <Link to="/chat" className="ui-btn ui-btn-secondary ui-btn-sm">
                  Start a chat
                </Link>
              }
            />
          )
        ) : (
          <>
            {active && total !== null && (
              <p className="mb-2 text-xs text-zinc-600 tabular-nums" aria-live="polite">
                {countLabel(sessions.length, total)}
              </p>
            )}
            <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  agentLabel={session.agent_id ? (agentNames.get(session.agent_id) ?? session.agent_id) : null}
                  onUpdated={(updated) =>
                    setSessions((prev) => prev && prev.map((s) => (s.id === updated.id ? updated : s)))
                  }
                  onChanged={reload}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
