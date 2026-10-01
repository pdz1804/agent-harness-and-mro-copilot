import { Brain, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { MemoryEditor } from '../components/memory/MemoryEditor'
import { MemoryRow } from '../components/memory/MemoryRow'
import { PageHeader } from '../components/ui/PageHeader'
import { useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Memory } from '../lib/api-types'

const SEARCH_DEBOUNCE_MS = 250

type Scope = 'mine' | 'all'

/** Long-term memory: the facts agents keep across conversations. Everything
 * shown is read from `/memories`; mutations patch local state from the
 * server's response (or refetch after a create). */
export function MemoryPage() {
  const { me } = useMe()
  const isAdmin = me?.role === 'admin'

  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('mine')
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  // A non-admin must never stay on the oversight scope (e.g. after an identity switch).
  const effectiveScope: Scope = isAdmin ? scope : 'mine'

  useEffect(() => {
    let cancelled = false
    api
      .listMemories({ q: query || undefined, scope: effectiveScope })
      .then((data) => {
        if (cancelled) return
        setMemories(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load memories.')
      })
    return () => {
      cancelled = true
    }
  }, [query, effectiveScope, refreshToken])

  const retry = () => {
    setMemories(null)
    setRefreshToken((n) => n + 1)
  }

  const searching = query !== ''

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Memory"
        description="Facts your agents keep across conversations. They save one with the remember tool and bring it back with recall; you can also add, correct or remove facts here."
        actions={
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={adding}
            className="ui-btn ui-btn-primary"
          >
            <Plus size={14} weight="bold" />
            Add memory
          </button>
        }
      />

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="memory-search" className="ui-section-label mb-1 block">
            Search
          </label>
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-500"
            />
            <input
              id="memory-search"
              name="memory-search"
              type="search"
              autoComplete="off"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search facts and tags…"
              className="ui-input w-full pl-8"
            />
          </div>
        </div>
        {isAdmin && (
          <div>
            <label htmlFor="memory-scope" className="ui-section-label mb-1 block">
              Whose memories
            </label>
            <select
              id="memory-scope"
              name="memory-scope"
              value={scope}
              onChange={(e) => {
                setMemories(null)
                setScope(e.target.value as Scope)
              }}
              className="ui-input"
            >
              <option value="mine">Mine</option>
              <option value="all">All users</option>
            </select>
          </div>
        )}
      </div>

      {adding && (
        <section className="ui-card mt-4 p-4" aria-label="Add memory">
          <MemoryEditor
            idPrefix="add-memory"
            submitLabel="Save memory"
            autoFocus
            onCancel={() => setAdding(false)}
            onSubmit={async (fact, tags) => {
              await api.createMemory({ fact, tags })
              setAdding(false)
              retry()
            }}
          />
        </section>
      )}

      <div className="mt-4">
        {error ? (
          <ErrorBanner message={`${error} Check that the backend is running, then retry.`} onRetry={retry} />
        ) : memories === null ? (
          <div className="space-y-2" role="status" aria-label="Loading memories">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : memories.length === 0 ? (
          searching ? (
            <EmptyState
              icon={<MagnifyingGlass size={32} weight="duotone" />}
              title="No memories match your search"
              description={`Nothing matches "${query}". Try a shorter or different word, or clear the search.`}
              action={
                <button type="button" onClick={() => setSearchInput('')} className="ui-btn ui-btn-secondary ui-btn-sm">
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<Brain size={32} weight="duotone" />}
              title="Nothing remembered yet"
              description='Ask an agent in a chat to "remember that ...", or use Add memory to write a fact yourself. Saved facts appear here.'
            />
          )
        ) : (
          <>
            <p className="mb-2 text-xs text-zinc-600 tabular-nums" aria-live="polite">
              {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
              {searching ? ` matching "${query}"` : ''}
              {effectiveScope === 'all' ? ' across all users' : ''}
            </p>
            <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
              {memories.map((memory) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  showOwner={effectiveScope === 'all'}
                  onUpdated={(updated) =>
                    setMemories((prev) => prev && prev.map((m) => (m.id === updated.id ? updated : m)))
                  }
                  onDeleted={(id) => setMemories((prev) => prev && prev.filter((m) => m.id !== id))}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
