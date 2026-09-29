import { BookOpen, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { ApiError, api } from '../lib/api'
import type { KBDoc, KBSearchResult } from '../lib/api-types'

export function KnowledgeBasePage() {
  const [docs, setDocs] = useState<KBDoc[] | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KBSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listKbDocs()
      .then((data) => {
        if (!cancelled) setDocs(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setDocsError(err instanceof ApiError ? err.message : 'Failed to load KB docs.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return
    setSearching(true)
    setSearchError(null)
    try {
      const data = await api.searchKb(trimmed, 5)
      setResults(data)
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-zinc-100">Knowledge base</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {docs ? docs.length : '…'} mock ops runbooks, indexed with real BM25 retrieval — the same
        ranking function the <code className="font-data">search_knowledge_base</code> tool uses.
      </p>

      <form onSubmit={(e) => void handleSearch(e)} className="mt-6 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. auth-service outage session store"
          className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!query.trim() || searching}
          className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MagnifyingGlass size={16} weight="bold" />
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchError && (
        <div className="mt-3">
          <ErrorBanner message={searchError} />
        </div>
      )}

      {results !== null && (
        <section className="mt-4">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Results ({results.length})
          </h2>
          {results.length === 0 ? (
            <p className="text-sm text-zinc-500">No matches.</p>
          ) : (
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.id} className="rounded-lg border border-zinc-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-zinc-100">{r.title}</span>
                    <span className="font-data text-xs text-zinc-600">score {r.score.toFixed(2)}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{r.id}</p>
                  <p className="mt-1 text-sm text-zinc-400">{r.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">All docs</h2>
        {docsError ? (
          <ErrorBanner message={docsError} />
        ) : docs === null ? (
          <div className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-900 overflow-hidden rounded-lg border border-zinc-800">
            {docs.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <BookOpen size={14} className="shrink-0 text-zinc-600" />
                <span className="min-w-0 truncate text-zinc-200">{doc.title}</span>
                <span className="font-data ml-auto shrink-0 text-xs text-zinc-600">{doc.id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
