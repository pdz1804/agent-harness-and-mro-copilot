import { ArrowClockwise, BookOpen, Copy, Flask, MagnifyingGlass, PlusCircle, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AddDocumentSheet } from '../components/kb/AddDocumentForm'
import { DocSheet } from '../components/kb/DocSheet'
import { Marked } from '../components/kb/Marked'
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  ErrorState,
  FilteredEmpty,
  Input,
  PageHeader,
  Row,
  RowActions,
  SearchInput,
  Segmented,
  Select,
  SortHeader,
  Table,
  TableSkeleton,
  CardGridSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { disabledReason, useMe } from '../hooks/useMe'
import { api, errorText } from '../lib/api'
import type { KBDoc, KBRetrieveResult, RetrievalMode } from '../lib/api-types'
import { KB_SORT_COLUMNS, docKindLabel, docSortKey, filterDocs, stepIndex } from '../lib/kb-docs'
import { tokenizeQuery } from '../lib/kb-highlight'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'
import { useUrlEnum, useUrlState } from '../hooks/useUrlState'

const SEARCH_DEBOUNCE_MS = 250
const TABS = ['docs', 'playground'] as const
type Tab = (typeof TABS)[number]
const MODES: readonly RetrievalMode[] = ['hybrid', 'bm25', 'dense']
const MODE_LABELS: Record<RetrievalMode, string> = {
  hybrid: 'Hybrid (BM25 + vector, fused)',
  bm25: 'BM25 only',
  dense: 'Vector only',
}

function Score({ label, value, rank }: { label: string; value: number | null; rank?: number | null }) {
  if (value === null) return null
  return (
    <Chip mono>
      <span className="text-zinc-500">{label}</span> {value.toFixed(label === 'RRF' ? 4 : 2)}
      {rank ? <span className="text-zinc-500"> #{rank}</span> : null}
    </Chip>
  )
}

/** Knowledge base: browse every document (chunked and indexed for real) in a
 * sortable table, read one in a sheet (`/knowledge/:docId`) with search hits
 * highlighted, add or delete documents, reindex, and a retrieval playground
 * that shows each ranked chunk's BM25, vector and fused scores and which
 * chunks the agent's search tool would actually return. The tab, the filter
 * or playground query, the sort and the add flow live in the URL. */
export function KnowledgeBasePage() {
  const { docId } = useParams<{ docId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [, setParams] = useSearchParams()
  const toast = useToast()
  const { me, loading: meLoading } = useMe()
  const canMutate = !me || me.permissions.includes('mutate_kb')
  const mutateBlocked = canMutate ? null : disabledReason(me, 'mutate_kb')

  const [tab] = useUrlEnum<Tab>('tab', TABS, 'docs')
  const [q] = useUrlState('q')
  const [mode, setMode] = useUrlEnum<RetrievalMode>('mode', MODES, 'hybrid')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [addFlag, setAddFlag] = useUrlState('add')
  const chunkParam = new URLSearchParams(location.search).get('chunk')
  const focusChunk = chunkParam !== null && /^\d+$/.test(chunkParam) ? Number(chunkParam) : null

  /** Several parameters in one history entry (two setters in a row would
   * overwrite each other). `null` removes a parameter. */
  const patchParams = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  const [docs, setDocs] = useState<KBDoc[] | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [adding, setAdding] = useState(false)
  const [reindexing, setReindexing] = useState(false)

  const [filterInput, setFilterInput] = useState(q)
  const [draft, setDraft] = useState(q)
  const [result, setResult] = useState<KBRetrieveResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [runToken, setRunToken] = useState(0)

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    api.listKbDocs().then(
      (data) => {
        if (cancelled) return
        setDocs(data)
        setDocsError(null)
      },
      (err: unknown) => {
        if (!cancelled) setDocsError(errorText(err, 'Failed to load KB docs.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  // The documents filter debounces into the URL; the playground query is
  // written on submit instead, so only run this on the documents tab.
  useEffect(() => {
    if (tab !== 'docs') return
    const timer = setTimeout(() => {
      if (filterInput !== q) patchParams({ q: filterInput.trim() === '' ? null : filterInput })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filterInput, q, tab, patchParams])

  // The playground input follows the URL (Open in playground, Back, reload).
  useEffect(() => {
    if (tab === 'playground') setDraft(q)
  }, [tab, q])

  useEffect(() => {
    if (tab !== 'playground' || !q.trim()) {
      setResult(null)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    api.retrieveKb(q.trim(), mode, 10).then(
      (data) => {
        if (cancelled) return
        setResult(data)
        setSearching(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setSearchError(errorText(err, 'Search failed.'))
        setSearching(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [tab, q, mode, runToken])

  // `?add=1` (command palette) opens the add sheet once, then clears the flag.
  useEffect(() => {
    if (addFlag !== '1' || meLoading) return
    setAddFlag('')
    if (!canMutate) {
      toast({ tone: 'error', title: "Can't add a document", description: mutateBlocked ?? undefined })
      return
    }
    setAdding(true)
  }, [addFlag, meLoading, canMutate, mutateBlocked, setAddFlag, toast])

  const sort = parseSort(sortRaw, KB_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const filterQuery = tab === 'docs' ? q : ''
  const rows = useMemo(() => sortRows(filterDocs(docs ?? [], filterQuery), sort, docSortKey), [docs, filterQuery, sort])
  const terms = useMemo(() => (q.trim() ? tokenizeQuery(q) : []), [q])

  /** Open/close the doc sheet while keeping the rest of the query string. */
  const openDoc = (id: string, chunk?: number) => {
    const search = new URLSearchParams(location.search)
    if (chunk === undefined) search.delete('chunk')
    else search.set('chunk', String(chunk))
    const qs = search.toString()
    navigate({ pathname: `/knowledge/${encodeURIComponent(id)}`, search: qs ? `?${qs}` : '' })
  }
  const closeDoc = () => {
    const search = new URLSearchParams(location.search)
    search.delete('chunk')
    const qs = search.toString()
    navigate({ pathname: '/knowledge', search: qs ? `?${qs}` : '' })
  }
  const openIndex = rows.findIndex((d) => d.id === docId)
  const step = (delta: 1 | -1) => {
    const next = rows[stepIndex(rows.length, openIndex, delta)]
    if (next) openDoc(next.id)
  }

  const changeTab = (next: Tab) => {
    setFilterInput('')
    setDraft('')
    patchParams({ tab: next === 'docs' ? null : next, q: null, chunk: null })
  }

  const runSearch = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed) return
    if (trimmed === q) setRunToken((n) => n + 1)
    else patchParams({ q: trimmed })
  }

  const openInPlayground = (doc: { id: string; title: string }) => {
    setDraft(doc.title)
    navigate({ pathname: '/knowledge', search: `?${new URLSearchParams({ tab: 'playground', q: doc.title })}` })
  }

  const copyId = (id: string) => {
    void navigator.clipboard?.writeText(id).then(
      () => toast({ title: 'Copied the document ID', description: id }),
      () => toast({ tone: 'error', title: "Couldn't copy", description: 'Clipboard access was denied.' }),
    )
  }

  const handleReindex = async () => {
    setReindexing(true)
    try {
      const r = await api.reindexKb()
      toast({
        title: `Reindexed ${r.documents} documents`,
        description: `${r.chunks} chunks in ${r.took_ms} ms${r.dense_ready ? ', vector embeddings ready' : ', BM25 only: the vector model is not loaded'}.`,
      })
      reload()
      setRunToken((n) => n + 1)
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't reindex", description: errorText(err, 'Try again.') })
    } finally {
      setReindexing(false)
    }
  }

  /** Soft-delete; Undo restores from the trash. Reports its own failures. */
  const deleteDoc = async (doc: { id: string; title: string }) => {
    try {
      await api.deleteKbDoc(doc.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${doc.title}”`, description: errorText(err, 'Try again.') })
      return
    }
    if (docId === doc.id) closeDoc()
    reload()
    toast({
      title: `Deleted “${doc.title}”`,
      description: 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreKbDoc(doc.id)
          reload()
          setRunToken((n) => n + 1)
          toast({ title: `Restored “${doc.title}”` })
        },
      },
    })
  }

  const deleteBlockedFor = (source: KBDoc['source']): string | null => {
    if (mutateBlocked) return mutateBlocked
    return source === 'upload' ? null : 'Seed runbooks are read-only. Only documents you add can be deleted.'
  }

  const rowActions = (doc: KBDoc): RowAction[] => {
    const blocked = deleteBlockedFor(doc.source)
    return [
      { label: 'Open in playground', icon: <Flask size={14} />, onSelect: () => openInPlayground(doc) },
      { label: 'Copy ID', icon: <Copy size={14} />, onSelect: () => copyId(doc.id) },
      {
        label: 'Delete',
        icon: <Trash size={14} />,
        destructive: true,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        confirm: { title: `Delete “${doc.title}”?`, description: 'It leaves the index now. You can undo for a few seconds.' },
        onSelect: () => deleteDoc(doc),
      },
    ]
  }

  const clearFilter = () => {
    setFilterInput('')
    patchParams({ q: null })
  }

  const listedDoc = docs?.find((d) => d.id === docId) ?? null
  const addAction = (
    <Button variant="primary" icon={<PlusCircle size={14} weight="bold" />} onClick={() => setAdding(true)} disabled={!canMutate} title={mutateBlocked ?? undefined}>
      Add document
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Knowledge base"
        description={
          <>
            {docs ? docs.length : '…'} documents, chunked and indexed with real BM25 + vector retrieval: the same ranking the <code className="font-data">search_knowledge_base</code> tool uses. The
            seed runbooks are mock content; anything you add is real.
          </>
        }
        actions={
          <>
            <Button icon={<ArrowClockwise size={14} weight="bold" />} loading={reindexing} onClick={() => void handleReindex()} disabled={!canMutate} title={mutateBlocked ?? 'Rebuild the index from every document'}>
              {reindexing ? 'Reindexing' : 'Reindex'}
            </Button>
            {addAction}
          </>
        }
        toolbar={
          <>
            <Segmented
              label="Knowledge base view"
              value={tab}
              onChange={changeTab}
              options={[
                { value: 'docs', label: 'Documents', count: docs?.length },
                { value: 'playground', label: 'Retrieval playground' },
              ]}
            />
            {tab === 'docs' ? (
              <>
                <SearchInput label="Filter documents" placeholder="Filter by title or ID" value={filterInput} onValueChange={setFilterInput} className="w-full sm:w-72" />
                {docs && filterQuery && (
                  <span className="text-xs text-zinc-500 tabular-nums" aria-live="polite">
                    {rows.length} of {docs.length}
                  </span>
                )}
              </>
            ) : (
              <form onSubmit={runSearch} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Input
                  type="text"
                  name="q"
                  autoComplete="off"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="e.g. auth-service outage session store"
                  aria-label="Search query"
                  className="min-w-[12rem] flex-1"
                />
                <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value as RetrievalMode)} aria-label="Retrieval mode">
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="primary" icon={<MagnifyingGlass size={14} weight="bold" />} loading={searching} disabled={!draft.trim()}>
                  {searching ? 'Searching' : 'Search'}
                </Button>
              </form>
            )}
          </>
        }
      />

      {tab === 'docs' ? (
        docsError && docs === null ? (
          <ErrorState message={`${docsError} Check that the backend is running.`} onRetry={() => {
            setDocsError(null)
            reload()
          }} />
        ) : docs === null ? (
          <TableSkeleton rows={6} columns={4} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={22} weight="duotone" />}
            title="No documents yet"
            description="Add a runbook or any note and it is chunked and indexed immediately, so the agent's search tool can find it."
            action={addAction}
            example="Try: a markdown runbook with a heading and a few steps."
          />
        ) : rows.length === 0 ? (
          <FilteredEmpty query={filterQuery || undefined} what="documents" onClear={clearFilter} />
        ) : (
          <Table label="Knowledge base documents">
            <thead>
              <tr>
                <SortHeader column="title" sort={sort} onSort={onSort}>
                  Document
                </SortHeader>
                <SortHeader column="chunks" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                  Chunks
                </SortHeader>
                <SortHeader column="size" sort={sort} onSort={onSort} className="hidden md:table-cell">
                  Size
                </SortHeader>
                <SortHeader column="kind" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                  Kind
                </SortHeader>
                <th className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody data-testid="kb-doc-list">
              {rows.map((doc) => (
                <Row key={doc.id} onOpen={() => openDoc(doc.id)} selected={doc.id === docId}>
                  <td className="max-w-0 min-w-[12rem]">
                    <p className="truncate font-medium text-zinc-900" title={doc.title}>
                      {doc.title}
                    </p>
                    <p className="font-data truncate text-xs text-zinc-500">{doc.id}</p>
                  </td>
                  <td className="hidden text-zinc-600 tabular-nums sm:table-cell">{doc.chunk_count ?? '—'}</td>
                  <td className="hidden text-zinc-600 tabular-nums md:table-cell">{doc.chars !== undefined ? `${doc.chars.toLocaleString()} chars` : '—'}</td>
                  <td className="hidden sm:table-cell">
                    <Chip tone={doc.source === 'upload' ? 'iris' : 'muted'}>{docKindLabel(doc)}</Chip>
                  </td>
                  <td className="text-right">
                    <RowActions label={`Actions for “${doc.title}”`} items={rowActions(doc)} />
                  </td>
                </Row>
              ))}
            </tbody>
          </Table>
        )
      ) : (
        <section data-testid="kb-results" aria-label="Retrieval results" className="pt-3">
          {searchError && <ErrorBanner message={searchError} onRetry={() => setRunToken((n) => n + 1)} />}
          {!q.trim() ? (
            <EmptyState
              icon={<Flask size={22} weight="duotone" />}
              title="Try a query against the index"
              description="See every ranked chunk with its BM25, vector and fused scores, and which chunks the agent's search tool would actually return."
              example="Try: “auth-service outage session store”"
            />
          ) : result === null && !searchError ? (
            <CardGridSkeleton count={4} className="grid gap-3" />
          ) : result && result.hits.length === 0 ? (
            <FilteredEmpty query={q} what="chunks" onClear={() => patchParams({ q: null })} />
          ) : (
            result && (
              <div className={searching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                <dl aria-label="Query stats" className="mb-4 grid gap-3 sm:grid-cols-3">
                  <Card>
                    <dt className="text-xs text-zinc-500">Latency</dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums">
                      {Math.round(result.latency_ms)}
                      <span className="ml-0.5 text-sm font-normal text-zinc-500">ms</span>
                    </dd>
                    <dd className="text-xs text-zinc-500">server ranking · {result.effective_mode}</dd>
                  </Card>
                  <Card>
                    <dt className="text-xs text-zinc-500">Chunks ranked</dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums">
                      {result.indexed_chunks} → {result.hits.filter((h) => h.would_return).length}
                    </dd>
                    <dd className="text-xs text-zinc-500">chunks indexed → what the agent gets</dd>
                  </Card>
                  <Card>
                    <dt className="text-xs text-zinc-500">Vector model</dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">{result.dense_available ? 'Loaded' : 'Off'}</dd>
                    <dd className="text-xs text-zinc-500">{result.dense_available ? 'BM25 + vector, fused with RRF' : 'BM25 only'}</dd>
                  </Card>
                </dl>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <h2 className="font-[family-name:var(--font-sans)] text-[13px] font-semibold tracking-normal text-zinc-950">Ranked chunks ({result.hits.length})</h2>
                  <span>
                    mode <span className="font-data text-zinc-700">{result.effective_mode}</span>
                    {result.effective_mode !== result.mode && ` (requested ${result.mode}; the vector model is unavailable)`}
                  </span>
                  <Chip tone="ok" dot>
                    Green: what the agent's tool would return
                  </Chip>
                </div>
                <ul className="space-y-2">
                  {result.hits.map((hit, i) => (
                    <li key={`${hit.doc_id}-${hit.chunk_index}`}>
                      <Card padding="none" interactive className={hit.would_return ? '!border-emerald-300 bg-emerald-50/40' : ''}>
                        <button type="button" onClick={() => openDoc(hit.doc_id, hit.chunk_index)} className="block w-full rounded-[14px] p-3 text-left">
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
                      </Card>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </section>
      )}

      {docId && (
        <DocSheet
          key={docId}
          docId={docId}
          listed={listedDoc}
          query={q}
          focusChunk={focusChunk}
          deleteBlockedReason={deleteBlockedFor(listedDoc?.source ?? 'upload')}
          onClose={closeDoc}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          onDelete={deleteDoc}
          onOpenInPlayground={openInPlayground}
          onCopyId={copyId}
          refreshToken={reloadToken}
        />
      )}

      {adding && (
        <AddDocumentSheet
          onClose={() => setAdding(false)}
          onAdded={(doc) => {
            setAdding(false)
            reload()
            toast({
              title: `Added “${doc.title}”`,
              description: `${doc.chunk_count} chunk${doc.chunk_count === 1 ? '' : 's'} indexed.`,
              action: { label: 'Open', run: () => navigate(`/knowledge/${encodeURIComponent(doc.id)}`) },
            })
          }}
        />
      )}
    </div>
  )
}
