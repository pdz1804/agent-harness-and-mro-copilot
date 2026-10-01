import { Copy, Flask, Hash, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { api, errorText } from '../../lib/api'
import type { KBDoc, KBDocDetail } from '../../lib/api-types'
import { tokenizeQuery } from '../../lib/kb-highlight'
import { Button, Card, Chip, ConfirmPopover, CopyId, ErrorState, FactList, RelativeTime, RowActions, Segmented, Sheet, SheetSection, SheetSkeleton, type RowAction } from '../ui'
import { HighlightedMarkdown } from './HighlightedMarkdown'
import { Marked } from './Marked'

type ViewMode = 'chunks' | 'rendered' | 'raw'

interface DocSheetProps {
  docId: string
  /** The row as listed: gives an instant header while the detail loads. */
  listed: KBDoc | null
  /** Search query to highlight; empty for none. */
  query: string
  /** A chunk index to scroll to (from a retrieval hit). */
  focusChunk: number | null
  /** Why deleting is unavailable (role or read-only seed), else null. */
  deleteBlockedReason: string | null
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onDelete: (doc: { id: string; title: string }) => Promise<unknown>
  onOpenInPlayground: (doc: { id: string; title: string }) => void
  onCopyId: (id: string) => void
  /** Bumped by the page after a reindex so the chunks refetch. */
  refreshToken: number
}

/** One knowledge document in a sheet over the list: facts, the chunks the
 * retriever indexes (as cards, with per-chunk matches and BM25 for the
 * query), the rendered markdown and the raw source. Deep link:
 * `/knowledge/:docId`. */
export function DocSheet({ docId, listed, query, focusChunk, deleteBlockedReason, onClose, onPrev, onNext, onDelete, onOpenInPlayground, onCopyId, refreshToken }: DocSheetProps) {
  const [doc, setDoc] = useState<KBDocDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<ViewMode>('chunks')

  useEffect(() => {
    let cancelled = false
    setError(null)
    api.getKbDoc(docId, query.trim() || undefined).then(
      (data) => {
        if (!cancelled) setDoc(data)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load the document.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [docId, query, refreshToken, retry])

  const current = doc?.id === docId ? doc : null
  const title = current?.title ?? listed?.title ?? null
  useDocumentTitle(title)

  useEffect(() => {
    if (focusChunk === null || !current || view !== 'chunks') return
    const frame = requestAnimationFrame(() => document.getElementById(`kb-chunk-${focusChunk}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [focusChunk, current, view])

  const source = current?.source ?? listed?.source
  const terms = query.trim() ? tokenizeQuery(query) : []
  const target = { id: docId, title: title ?? docId }

  const actions: RowAction[] = [
    { label: 'Open in playground', icon: <MagnifyingGlass size={14} />, onSelect: () => onOpenInPlayground(target) },
    { label: 'Copy ID', icon: <Copy size={14} />, onSelect: () => onCopyId(docId) },
    {
      label: 'Delete',
      icon: <Trash size={14} />,
      destructive: true,
      disabled: deleteBlockedReason !== null,
      disabledReason: deleteBlockedReason ?? undefined,
      confirm: { title: `Delete “${target.title}”?`, description: 'It leaves the index now. You can undo for a few seconds.' },
      onSelect: () => onDelete(target),
    },
  ]

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      width="lg"
      eyebrow="Knowledge / Documents"
      label={title ?? 'Document'}
      title={title ?? 'Document'}
      status={source ? <Chip tone={source === 'upload' ? 'iris' : 'muted'}>{source === 'upload' ? 'Added' : 'Seed runbook'}</Chip> : undefined}
      meta={
        <>
          <CopyId value={docId} label="document ID" />
          {current && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{current.chunk_count} {current.chunk_count === 1 ? 'chunk' : 'chunks'}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{current.words.toLocaleString()} words</span>
            </>
          )}
        </>
      }
      headerActions={<RowActions visibility="always" label={`More actions for “${target.title}”`} items={actions} />}
      footer={
        <>
          {deleteBlockedReason && <p className="w-full min-w-0 text-xs text-zinc-500">{deleteBlockedReason}</p>}
          <ConfirmPopover
            icon={<Trash size={14} />}
            prompt={`Delete “${target.title}”?`}
            description="It leaves the index now. You can undo for a few seconds."
            disabled={deleteBlockedReason !== null || !current}
            title={deleteBlockedReason ?? undefined}
            onConfirm={() => onDelete(target)}
          >
            Delete
          </ConfirmPopover>
          <Button variant="primary" icon={<Flask size={14} weight="bold" />} onClick={() => onOpenInPlayground(target)}>
            Open in playground
          </Button>
        </>
      }
    >
      {error && !current ? (
        <ErrorState message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : !current ? (
        <SheetSkeleton />
      ) : (
        <div data-testid="kb-viewer">
          {terms.length > 0 && (
            <p className="mb-4 text-xs text-zinc-500" data-testid="kb-matched">
              Highlighting <span className="font-data text-zinc-700">{terms.join(', ')}</span> ·{' '}
              {current.matched_terms.length > 0 ? (
                <>
                  matched in this document: <span className="font-data text-zinc-700">{current.matched_terms.join(', ')}</span>
                </>
              ) : (
                'no query term occurs in this document'
              )}
            </p>
          )}
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Source', value: current.source === 'seed' ? 'Seed runbook (read-only)' : 'Added by a user' },
                { label: 'Size', value: `${current.chars.toLocaleString()} characters · ${current.words.toLocaleString()} words` },
                { label: 'Chunks indexed', value: current.chunk_count },
                current.source === 'seed'
                  ? { label: 'File', value: <span className="font-data text-xs">{current.filename ?? '—'}</span> }
                  : { label: 'Added', value: <span>{current.created_by ?? 'Unknown'} · <RelativeTime value={current.created_at} /></span> },
              ]}
            />
          </SheetSection>
          <SheetSection
            title="Content"
            actions={
              <Segmented
                label="Document view"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'chunks', label: 'Chunks', count: current.chunk_count },
                  { value: 'rendered', label: 'Rendered' },
                  { value: 'raw', label: 'Raw' },
                ]}
              />
            }
          >
            {view === 'chunks' && (
              <div className="space-y-2.5" data-testid="kb-chunks">
                <p className="text-xs text-zinc-500">The exact pieces the retriever indexes and the agent can be handed: paragraphs merged up to 800 characters, never split mid-paragraph.</p>
                {current.chunks.map((chunk) => (
                  <Card key={chunk.index} as="section" padding="sm" id={`kb-chunk-${chunk.index}`} selected={focusChunk === chunk.index}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                      <Chip mono icon={<Hash size={11} weight="bold" />}>
                        chunk {chunk.index}
                      </Chip>
                      <span className="tabular-nums">{chunk.chars} chars</span>
                      {chunk.char_start !== null && <span className="tabular-nums">offset {chunk.char_start}</span>}
                      {chunk.bm25_score !== null && (
                        <Chip tone="iris" mono>
                          BM25 {chunk.bm25_score.toFixed(2)}
                        </Chip>
                      )}
                      {chunk.matched_terms.length > 0 && <span className="text-amber-700">matches: {chunk.matched_terms.join(', ')}</span>}
                    </div>
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-800 [overflow-wrap:anywhere]">
                      <Marked text={chunk.text} terms={terms} />
                    </p>
                  </Card>
                ))}
              </div>
            )}
            {view === 'rendered' && (
              <Card padding="md">
                <HighlightedMarkdown source={current.content} terms={terms} />
              </Card>
            )}
            {view === 'raw' && (
              <Card padding="none">
                <pre className="font-data max-h-[32rem] overflow-auto p-4 text-xs whitespace-pre-wrap text-zinc-800 [overflow-wrap:anywhere]">
                  <Marked text={current.content} terms={terms} />
                </pre>
              </Card>
            )}
          </SheetSection>
        </div>
      )}
    </Sheet>
  )
}
