import { FileText, Hash, Trash } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { KBDocDetail } from '../../lib/api-types'
import { tokenizeQuery } from '../../lib/kb-highlight'
import { ErrorBanner } from '../ErrorBanner'
import { Skeleton } from '../Skeleton'
import { HighlightedMarkdown } from './HighlightedMarkdown'
import { Marked } from './Marked'
import { ConfirmButton } from '../ui/ConfirmButton'

type ViewMode = 'rendered' | 'chunks' | 'raw'

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-zinc-500 ">{label}</dt>
      <dd className="font-data text-xs text-zinc-800">{value}</dd>
    </div>
  )
}

/** Full document viewer: rendered content with the search query's terms
 * highlighted, the exact chunks the retriever indexes (with per-chunk matched
 * terms and BM25 score for the query), the raw source, and metadata. */
export function DocViewer({
  docId,
  query,
  focusChunk,
  canDelete,
  onDeleted,
}: {
  docId: string
  /** Search query to highlight; empty for none. */
  query: string
  /** A chunk index to scroll to (from a retrieval hit). */
  focusChunk: number | null
  canDelete: boolean
  onDeleted: () => void
}) {
  const [doc, setDoc] = useState<KBDocDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The parent remounts this viewer (key) when a retrieval hit is opened, so a
  // focused chunk simply starts in the chunk view.
  const [mode, setMode] = useState<ViewMode>(focusChunk !== null ? 'chunks' : 'rendered')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getKbDoc(docId, query.trim() || undefined)
      .then((data) => {
        if (cancelled) return
        setError(null)
        setDoc(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load the document.')
      })
    return () => {
      cancelled = true
    }
  }, [docId, query])

  useEffect(() => {
    if (focusChunk === null || !doc || mode !== 'chunks') return
    const frame = requestAnimationFrame(() =>
      document.getElementById(`kb-chunk-${focusChunk}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [focusChunk, doc, mode])

  if (error) return <ErrorBanner message={error} />
  if (!doc || doc.id !== docId) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const terms = query.trim() ? tokenizeQuery(query) : []

  const remove = async () => {
    setDeleting(true)
    try {
      await api.deleteKbDoc(doc.id)
      onDeleted()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete the document.')
      setDeleting(false)
    }
  }

  return (
    <article className="space-y-3" data-testid="kb-viewer">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900">
            <FileText size={18} className="shrink-0 text-sky-600" />
            <span className="truncate">{doc.title}</span>
          </h2>
          <p className="font-data text-xs text-zinc-500">{doc.id}</p>
        </div>
        {canDelete && doc.source === 'upload' && (
          <ConfirmButton
            prompt={`Delete "${doc.title}" from the knowledge base?`}
            onConfirm={() => void remove()}
            disabled={deleting}
            className="ui-btn ui-btn-danger ui-btn-sm shrink-0"
          >
            <Trash size={13} />
            {deleting ? 'Deleting…' : 'Delete'}
          </ConfirmButton>
        )}
      </div>

      <dl className="ui-card grid grid-cols-2 gap-3 p-3 sm:grid-cols-4">
        <MetaItem label="Source" value={doc.source === 'seed' ? 'seed runbook (read-only)' : 'uploaded'} />
        <MetaItem label="Size" value={`${doc.chars.toLocaleString()} chars · ${doc.words.toLocaleString()} words`} />
        <MetaItem label="Chunks indexed" value={String(doc.chunk_count)} />
        <MetaItem
          label={doc.source === 'seed' ? 'File' : 'Added'}
          value={doc.source === 'seed' ? (doc.filename ?? '—') : `${doc.created_by ?? '?'} · ${doc.created_at ? new Date(doc.created_at).toLocaleDateString() : ''}`}
        />
      </dl>

      {terms.length > 0 && (
        <p className="text-xs text-zinc-500" data-testid="kb-matched">
          Highlighting <span className="font-data text-zinc-700">{terms.join(', ')}</span> ·{' '}
          {doc.matched_terms.length > 0 ? (
            <>
              matched in this document: <span className="font-data text-zinc-700">{doc.matched_terms.join(', ')}</span>
            </>
          ) : (
            'no query term occurs in this document'
          )}
        </p>
      )}

      <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 text-xs" role="tablist" aria-label="Document view">
        {(
          [
            ['rendered', 'Rendered'],
            ['chunks', `Chunks (${doc.chunk_count})`],
            ['raw', 'Raw'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`rounded px-3 py-1 font-medium transition ${
              mode === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'rendered' && (
        <div className="ui-card p-5">
          <HighlightedMarkdown source={doc.content} terms={terms} />
        </div>
      )}

      {mode === 'chunks' && (
        <div className="space-y-2.5" data-testid="kb-chunks">
          <p className="text-xs text-zinc-500">
            These are the exact pieces the retriever indexes and the agent can be handed — paragraphs merged up to 800
            characters, never split mid-paragraph.
          </p>
          {doc.chunks.map((chunk) => (
            <section
              key={chunk.index}
              id={`kb-chunk-${chunk.index}`}
              className={`ui-card p-3 ${focusChunk === chunk.index ? 'ring-2 ring-sky-300' : ''}`}
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1 font-data font-semibold text-zinc-700">
                  <Hash size={11} weight="bold" />
                  chunk {chunk.index}
                </span>
                <span>{chunk.chars} chars</span>
                {chunk.char_start !== null && <span>@ offset {chunk.char_start}</span>}
                {chunk.bm25_score !== null && (
                  <span className="font-data rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">BM25 {chunk.bm25_score.toFixed(2)}</span>
                )}
                {chunk.matched_terms.length > 0 && <span className="text-amber-700">matches: {chunk.matched_terms.join(', ')}</span>}
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-800">
                <Marked text={chunk.text} terms={terms} />
              </p>
            </section>
          ))}
        </div>
      )}

      {mode === 'raw' && (
        <pre className="font-data ui-card max-h-[32rem] overflow-auto p-4 text-xs whitespace-pre-wrap text-zinc-800">
          <Marked text={doc.content} terms={terms} />
        </pre>
      )}
    </article>
  )
}
