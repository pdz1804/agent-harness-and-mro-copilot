import { ArrowClockwise, BookOpen, MagnifyingGlass, PlusCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AddDocumentForm } from '../components/kb/AddDocumentForm'
import { DocViewer } from '../components/kb/DocViewer'
import { Marked } from '../components/kb/Marked'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { KBDoc, KBRetrieveResult, RetrievalMode } from '../lib/api-types'
import { tokenizeQuery } from '../lib/kb-highlight'
import { PageHeader } from '../components/ui/PageHeader'

const MODE_LABELS: Record<RetrievalMode, string> = {
  hybrid: 'Hybrid (BM25 + vector, fused)',
  bm25: 'BM25 only',
  dense: 'Vector only',
}

function Score({ label, value, rank }: { label: string; value: number | null; rank?: number | null }) {
  if (value === null) return null
  return (
    <span className="font-data inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">
      <span className="text-zinc-500">{label}</span>
      {value.toFixed(label === 'RRF' ? 4 : 2)}
      {rank ? <span className="text-zinc-500">#{rank}</span> : null}
    </span>
  )
}

/** Knowledge base: browse and read every document in full (rendered, as the
 * indexed chunks, or raw) with search hits highlighted; add or delete
 * documents (chunked and indexed for real); reindex; and a retrieval
 * playground that shows each ranked chunk's BM25, vector and fused scores
 * and which chunks the agent's search tool would actually return. */
export function KnowledgeBasePage() {
  const { docId } = useParams<{ docId?: string }>()
  const navigate = useNavigate()
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_kb') : false

  const [docs, setDocs] = useState<KBDoc[] | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [filter, setFilter] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [mode, setMode] = useState<RetrievalMode>('hybrid')
  const [result, setResult] = useState<KBRetrieveResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [focusChunk, setFocusChunk] = useState<number | null>(null)

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

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
  }, [reloadToken])

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return
    setSearching(true)
    setSearchError(null)
    try {
      setResult(await api.retrieveKb(trimmed, mode, 10))
      setSubmittedQuery(trimmed)
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  const handleReindex = async () => {
    setReindexing(true)
    setNotice(null)
    try {
      const r = await api.reindexKb()
      setNotice(
        `Reindexed ${r.documents} documents into ${r.chunks} chunks in ${r.took_ms} ms${r.dense_ready ? ' (vector embeddings ready)' : ' (BM25 only: vector model not loaded)'}.`,
      )
      reload()
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Reindex failed.')
    } finally {
      setReindexing(false)
    }
  }

  const visibleDocs = docs?.filter((d) => {
    const q = filter.trim().toLowerCase()
    return !q || d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)
  })
  const terms = submittedQuery ? tokenizeQuery(submittedQuery) : []

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Knowledge base"
        description={<>{docs ? docs.length : '…'} documents, chunked and indexed with real BM25 + vector retrieval — the same
            ranking the <code className="font-data">search_knowledge_base</code> tool uses. The 18 runbooks are
            mock content; anything you add is real.</>}
        actions={<><div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleReindex()}
            disabled={!canMutate || reindexing}
            title={canMutate ? 'Rebuild the index from every document' : disabledReason(me, 'mutate_kb')}
            className="ui-btn ui-btn-secondary"
          >
            <ArrowClockwise size={14} weight="bold" className={reindexing ? 'animate-spin' : ''} />
            {reindexing ? 'Reindexing…' : 'Reindex'}
          </button>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            disabled={!canMutate}
            title={canMutate ? undefined : disabledReason(me, 'mutate_kb')}
            className="ui-btn ui-btn-primary"
          >
            <PlusCircle size={14} weight="bold" />
            Add document
          </button>
        </div></>}
      />

      {notice && (
        <p className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800" role="status">
          {notice}
        </p>
      )}

      {showAdd && (
        <div className="mt-4">
          <AddDocumentForm
            onCancel={() => setShowAdd(false)}
            onAdded={(doc) => {
              setShowAdd(false)
              setNotice(`Added "${doc.title}": ${doc.chunk_count} chunk${doc.chunk_count === 1 ? '' : 's'} indexed.`)
              reload()
              navigate(`/knowledge/${doc.id}`)
            }}
          />
        </div>
      )}

      <form onSubmit={(e) => void handleSearch(e)} className="mt-5 flex flex-wrap gap-2">
        <input
          type="text"
          name="q"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. auth-service outage session store…"
          aria-label="Search query"
          className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
        <select
          name="mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as RetrievalMode)}
          aria-label="Retrieval mode"
          className="rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-700 focus:border-sky-500 focus:outline-none"
        >
          {(Object.keys(MODE_LABELS) as RetrievalMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!query.trim() || searching}
          className="ui-btn ui-btn-primary ui-btn-sm"
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

      {result && (
        <section className="mt-4" data-testid="kb-results">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <h2 className="font-semibold text-zinc-500 ">Ranked chunks ({result.hits.length})</h2>
            <span>
              mode <span className="font-data text-zinc-700">{result.effective_mode}</span>
              {result.effective_mode !== result.mode && ` (requested ${result.mode}; the vector model is unavailable)`}
            </span>
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">green = what the agent's tool would return</span>
          </div>
          {result.hits.length === 0 ? (
            <p className="text-sm text-zinc-500">No chunk matches those terms.</p>
          ) : (
            <ul className="space-y-2">
              {result.hits.map((hit, i) => (
                <li key={`${hit.doc_id}-${hit.chunk_index}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setFocusChunk(hit.chunk_index)
                      navigate(`/knowledge/${hit.doc_id}`)
                    }}
                    className={`ui-card block w-full p-3 text-left transition hover:border-sky-300 ${
                      hit.would_return ? 'border-emerald-300 bg-emerald-50/40' : ''
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-data text-xs text-zinc-500">#{i + 1}</span>
                      <span className="text-sm font-medium text-zinc-900">{hit.title}</span>
                      <span className="font-data text-xs text-zinc-500">
                        {hit.doc_id} · chunk {hit.chunk_index}
                      </span>
                      <span className="ml-auto flex flex-wrap gap-1">
                        <Score label="BM25" value={hit.bm25_score} rank={hit.bm25_rank} />
                        <Score label="vector" value={hit.dense_score} rank={hit.dense_rank} />
                        <Score label="RRF" value={hit.fused_score} />
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-sm text-zinc-600">
                      <Marked text={hit.text} terms={terms} />
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-[300px_1fr]">
        <section className={docId ? 'hidden md:block' : ''}>
          <h2 className="mb-2 text-xs font-semibold text-zinc-500 ">Documents</h2>
          <input
            name="filter"
            autoComplete="off"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title or id…"
            aria-label="Filter documents"
            className="mb-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          />
          {docsError ? (
            <ErrorBanner message={docsError} />
          ) : docs === null ? (
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : (
            <ul className="ui-list ui-card max-h-[34rem] divide-y divide-zinc-200 overflow-y-auto" data-testid="kb-doc-list">
              {visibleDocs?.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setFocusChunk(null)
                      navigate(`/knowledge/${doc.id}`)
                    }}
                    aria-current={doc.id === docId ? 'true' : undefined}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition hover:bg-zinc-50 ${
                      doc.id === docId ? 'bg-sky-50/70' : ''
                    }`}
                  >
                    <BookOpen size={14} className="mt-0.5 shrink-0 text-zinc-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-zinc-800">{doc.title}</span>
                      <span className="font-data block truncate text-xs text-zinc-500">
                        {doc.chunk_count ?? '?'} chunks · {doc.chars?.toLocaleString() ?? '?'} chars
                      </span>
                    </span>
                    {doc.source === 'upload' && (
                      <span className="shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-800">
                        added
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {visibleDocs?.length === 0 && <li className="px-3 py-3 text-sm text-zinc-500">No document matches.</li>}
            </ul>
          )}
        </section>

        <section className={docId ? '' : 'hidden md:block'}>
          {docId ? (
            <>
              <button
                type="button"
                onClick={() => navigate('/knowledge')}
                className="mb-2 text-xs font-medium text-zinc-500 hover:text-zinc-900 md:hidden"
              >
                ← Back to documents
              </button>
              <DocViewer
                key={`${docId}:${focusChunk ?? ''}`}
                docId={docId}
                query={submittedQuery}
                focusChunk={focusChunk}
                canDelete={canMutate}
                onDeleted={() => {
                  reload()
                  navigate('/knowledge')
                }}
              />
            </>
          ) : (
            <EmptyState
              icon={<BookOpen size={32} />}
              title="Open a document"
              description="Pick a document to read it in full, see the chunks the retriever uses, and check its metadata. Search above to highlight hits."
            />
          )}
        </section>
      </div>
    </div>
  )
}
