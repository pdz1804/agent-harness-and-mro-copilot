import { Archive, ArrowCounterClockwise, ArrowSquareOut, ChatsCircle, Export, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { downloadText, exportFileName, toCsv } from '../lib/export-file'
import { Link, useNavigate } from 'react-router-dom'
import {
  BulkBar,
  Button,
  Chip,
  ConfirmPopover,
  CopyId,
  EmptyState,
  ErrorState,
  FactList,
  FilteredEmpty,
  Input,
  LinkButton,
  PageHeader,
  RelativeTime,
  Row,
  RowActions,
  SearchInput,
  Segmented,
  Select,
  SelectBox,
  Sheet,
  SheetSection,
  SheetSkeleton,
  SortHeader,
  StatusBadge,
  Table,
  TableSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Agent, ArchivedFilter, ChatSession, SessionDetail } from '../lib/api-types'
import { bulkSummary, pruneSelection, runBulk, toggleId } from '../lib/bulk'
import { buildFilters, countLabel, hasActiveFilters, type SessionFilterState } from '../lib/session-filters'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const SEARCH_DEBOUNCE_MS = 250
const POLL_INTERVAL_MS = 4_000
const FILTER_KEYS = ['q', 'status', 'agent', 'from', 'to', 'archived']
const SORT_COLUMNS = ['title', 'status', 'last_active'] as const

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'running', label: 'Running' },
  { value: 'pending_approval', label: 'Waiting for approval' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Stopped' },
  { value: 'guardrail_blocked', label: 'Blocked by guardrail' },
  { value: 'idle', label: 'Idle (no run yet)' },
  { value: 'step_limit_exceeded', label: 'Step limit exceeded' },
  { value: 'time_limit_exceeded', label: 'Time limit exceeded' },
  { value: 'llm_error_exceeded', label: 'LLM error limit' },
]

function SessionStatus({ status }: { status: ChatSession['status'] }) {
  if (status === 'idle') return <Chip dot>Idle</Chip>
  return <StatusBadge status={status} />
}

/** Sessions: a sortable, multi-select table with live status (`GET /sessions`
 * recomputes status server-side, so a short poll keeps it current). Filters,
 * sort and the open session sheet live in the URL. Every mutation toasts with
 * Undo: archive <-> restore, delete -> restore (deletes are soft). */
export function SessionsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlState('status')
  const [agentId, setAgentId] = useUrlState('agent')
  const [fromDate, setFromDate] = useUrlState('from')
  const [toDate, setToDate] = useUrlState('to')
  const [archived, setArchived] = useUrlEnum<ArchivedFilter>('archived', ['exclude', 'include', 'only'], 'exclude')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openId, setOpenId] = useUrlState('open')
  const clearParams = useClearUrlParams()

  const [searchInput, setSearchInput] = useState(q)
  const [sessions, setSessions] = useState<ChatSession[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== q) setQ(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, setQ])

  useEffect(() => {
    let cancelled = false
    api.listAgents().then(
      (data) => {
        if (!cancelled) setAgents(data)
      },
      () => {
        /* Agent names are a nicety: rows fall back to the raw agent id. */
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const filterState: SessionFilterState = { q, status, agentId, fromDate, toDate, archived }
  const active = hasActiveFilters(filterState)
  const apiFilters = buildFilters(filterState)
  const filterKey = JSON.stringify(apiFilters)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      const filtered = api.listSessions(apiFilters)
      // The "of N" denominator is every session the user can see, ignoring filters.
      const everything = active ? api.listSessions({ archived: 'include' }) : null
      Promise.all([filtered, everything]).then(
        ([data, all]) => {
          if (cancelled) return
          setSessions(data)
          setTotal(all ? all.length : data.length)
          setError(null)
          setUpdatedAt(Date.now())
        },
        (err: unknown) => {
          if (!cancelled) setError(errorText(err, 'Could not load sessions.'))
        },
      )
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

  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])
  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const agentLabel = (id: string | null) => (id ? (agentNames.get(id) ?? id) : 'No agent')
  const sort = parseSort(sortRaw, SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const rows = useMemo(
    () =>
      sortRows(sessions ?? [], parseSort(sortRaw, SORT_COLUMNS), (s, column) =>
        column === 'title' ? s.title : column === 'status' ? s.status : (s.last_active_at ?? s.created_at),
      ),
    [sessions, sortRaw],
  )

  // Exports exactly what the list shows: current filters and sort.
  const exportCsv = () => {
    const csv = toCsv(
      ['id', 'title', 'status', 'agent', 'owner', 'created_at', 'last_active_at', 'archived_at', 'last_run_id'],
      rows.map((s) => [s.id, s.title, s.status, agentLabel(s.agent_id), s.owner_id, s.created_at, s.last_active_at, s.archived_at, s.last_run_id]),
    )
    const name = exportFileName('sessions', 'csv')
    downloadText(name, csv, 'text/csv;charset=utf-8')
    toast({ title: `Exported ${rows.length} session${rows.length === 1 ? '' : 's'}`, description: name })
  }

  // Drop selections for rows that left the list (filter change, poll).
  useEffect(() => {
    if (sessions) setSelected((prev) => pruneSelection(prev, sessions.map((s) => s.id)))
  }, [sessions])

  const markBusy = (ids: string[], on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  /** Archive or restore `ids`, then toast with an Undo that flips them back. */
  const setArchivedFor = async (ids: string[], archive: boolean, label?: string) => {
    markBusy(ids, true)
    const result = await runBulk(ids, (id) => api.updateSession(id, { archived: archive }))
    markBusy(ids, false)
    reload()
    if (result.ok.length === 0) {
      toast({
        tone: 'error',
        title: `Couldn't ${archive ? 'archive' : 'restore'} ${label ? `“${label}”` : 'the sessions'}`,
        description: errorText(result.failed[0]?.error, 'Try again.'),
      })
      return
    }
    setSelected(new Set())
    toast({
      title: label && result.ok.length === 1 ? `${archive ? 'Archived' : 'Restored'} “${label}”` : bulkSummary(archive ? 'Archived' : 'Restored', 'session', result),
      action: {
        label: 'Undo',
        run: async () => {
          const undo = await runBulk(result.ok, (id) => api.updateSession(id, { archived: !archive }))
          reload()
          if (undo.failed.length) throw new Error(`${undo.failed.length} could not be reverted`)
          toast({ title: archive ? 'Archive undone' : 'Restore undone' })
        },
      },
    })
  }

  /** Soft-delete `ids`; Undo restores them from the trash. */
  const deleteSessions = async (ids: string[], label?: string) => {
    markBusy(ids, true)
    const result = await runBulk(ids, (id) => api.deleteSession(id))
    markBusy(ids, false)
    reload()
    if (result.ok.length === 0) {
      toast({ tone: 'error', title: `Couldn't delete ${label ? `“${label}”` : 'the sessions'}`, description: errorText(result.failed[0]?.error, 'Try again.') })
      return
    }
    setSelected(new Set())
    if (openId && result.ok.includes(openId)) setOpenId('')
    toast({
      title: label && result.ok.length === 1 ? `Deleted “${label}”` : bulkSummary('Deleted', 'session', result),
      description: result.failed.length ? errorText(result.failed[0].error, 'Some could not be deleted.') : 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          const undo = await runBulk(result.ok, (id) => api.restoreSession(id))
          reload()
          if (undo.failed.length) throw new Error(`${undo.failed.length} could not be restored`)
          toast({ title: 'Delete undone' })
        },
      },
    })
  }

  const rename = async (session: ChatSession, title: string) => {
    const previous = session.title
    setRenamingId(null)
    if (!title || title === previous) return
    // Optimistic: the row shows the new title while the request is in flight.
    setSessions((list) => list && list.map((s) => (s.id === session.id ? { ...s, title } : s)))
    try {
      await api.updateSession(session.id, { title })
      toast({
        title: `Renamed to “${title}”`,
        action: {
          label: 'Undo',
          run: async () => {
            await api.updateSession(session.id, { title: previous })
            reload()
          },
        },
      })
    } catch (err) {
      setSessions((list) => list && list.map((s) => (s.id === session.id ? { ...s, title: previous } : s)))
      toast({ tone: 'error', title: "Couldn't rename the session", description: errorText(err, 'Try again.') })
    }
  }

  const clearFilters = () => {
    setSearchInput('')
    clearParams(FILTER_KEYS)
  }

  const selectedIds = rows.filter((s) => selected.has(s.id)).map((s) => s.id)
  const allSelected = rows.length > 0 && selectedIds.length === rows.length
  const allSelectedArchived = selectedIds.length > 0 && rows.filter((s) => selected.has(s.id)).every((s) => s.archived_at !== null)

  const openIndex = rows.findIndex((s) => s.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    const next = rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length]
    setOpenId(next.id)
  }

  const rowActions = (s: ChatSession, includeOpen = true): RowAction[] => {
    const isArchived = s.archived_at !== null
    return [
      ...(includeOpen && s.last_run_id ? [{ label: 'Open conversation', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/sessions/${s.id}`) }] : []),
      { label: 'Rename', icon: <PencilSimple size={14} />, onSelect: () => setRenamingId(s.id) },
      {
        label: isArchived ? 'Restore' : 'Archive',
        icon: isArchived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />,
        onSelect: () => setArchivedFor([s.id], !isArchived, s.title),
      },
      {
        label: 'Delete',
        icon: <Trash size={14} />,
        destructive: true,
        confirm: { title: `Delete “${s.title}”?`, description: 'Its runs go with it. You can undo for a few seconds; it stays in the trash for 7 days.' },
        onSelect: () => deleteSessions([s.id], s.title),
      },
    ]
  }

  const openSession = rows.find((s) => s.id === openId) ?? null

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sessions"
        description="Every chat you can see, newest first, with its live status. Filters live in the URL, so Back keeps them."
        actions={
          <>
            <Button icon={<Export size={14} weight="bold" />} disabled={rows.length === 0} title={rows.length === 0 ? 'Nothing to export' : 'Download the sessions this view shows'} onClick={exportCsv}>
              Export CSV
            </Button>
            <LinkButton to="/chat" variant="primary" icon={<Plus size={14} weight="bold" />}>
              New run
            </LinkButton>
          </>
        }
        toolbar={
          <>
            <SearchInput label="Search sessions" placeholder="Search title or objective" value={searchInput} onValueChange={setSearchInput} className="w-full sm:w-64" />
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="max-w-[12rem]">
              <option value="">Any agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <Input type="date" aria-label="From date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="tabular-nums" />
            <Input type="date" aria-label="To date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="tabular-nums" />
            <Segmented
              label="Archived"
              value={archived}
              onChange={setArchived}
              options={[
                { value: 'exclude', label: 'Active' },
                { value: 'only', label: 'Archived' },
                { value: 'include', label: 'All' },
              ]}
            />
            {(active || searchInput) && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-zinc-500" aria-live="polite">
              {active && sessions && total !== null ? `${countLabel(sessions.length, total)} · ` : ''}
              {updatedAt ? (
                <>
                  Updated <RelativeTime value={updatedAt} />
                </>
              ) : null}
            </span>
          </>
        }
      />

      {error && sessions === null ? (
        <ErrorState message={`${error} Check that the backend is running.`} onRetry={reload} />
      ) : sessions === null ? (
        <TableSkeleton rows={6} columns={5} />
      ) : rows.length === 0 ? (
        active ? (
          <FilteredEmpty query={q || undefined} what="sessions" onClear={clearFilters} />
        ) : (
          <EmptyState
            icon={<ChatsCircle size={22} weight="duotone" />}
            title="No sessions yet"
            description="Start a run and it appears here with its live status."
            action={
              <LinkButton to="/chat" variant="primary" icon={<Plus size={14} weight="bold" />}>
                New run
              </LinkButton>
            }
            example="Try: “Why is payments-api slow right now?”"
          />
        )
      ) : (
        <>
          {error && <p className="mb-2 text-xs text-rose-700">Live refresh failed: {error} Showing the last loaded list.</p>}
          {/* Phones: one tappable card per session (the table needs the width). */}
          <ul aria-label="Sessions" className="space-y-2 sm:hidden">
            {rows.map((s) => (
              <li key={s.id} className={`relative rounded-[14px] bg-white p-3 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] ${busyIds.has(s.id) ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-2">
                  <Link to={`/sessions/${s.id}`} className="min-w-0 flex-1 after:absolute after:inset-0 after:rounded-[14px] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-sky-500">
                    <span className="block truncate text-[15px] font-medium text-zinc-900">{s.title}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-zinc-500">
                    <RelativeTime value={s.last_active_at ?? s.created_at} />
                  </span>
                </div>
                <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                  <SessionStatus status={s.status} />
                  <span className="truncate">{agentLabel(s.agent_id)}</span>
                  {s.archived_at && <Chip tone="muted">Archived</Chip>}
                  <span className="relative z-10 ml-auto">
                    <RowActions visibility="always" label={`Actions for “${s.title}”`} items={rowActions(s)} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <Table label="Sessions" className="hidden sm:block">
            <thead>
              <tr>
                <th className="w-10">
                  <SelectBox
                    label="Select all sessions"
                    checked={allSelected}
                    indeterminate={selectedIds.length > 0}
                    onChange={(on) => setSelected(on ? new Set(rows.map((s) => s.id)) : new Set())}
                  />
                </th>
                <SortHeader column="title" sort={sort} onSort={onSort}>
                  Session
                </SortHeader>
                <SortHeader column="status" sort={sort} onSort={onSort}>
                  Status
                </SortHeader>
                <th className="hidden md:table-cell">Agent</th>
                <SortHeader column="last_active" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                  Last activity
                </SortHeader>
                <th className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Row key={s.id} onOpen={() => setOpenId(s.id)} selected={selected.has(s.id) || s.id === openId} className={busyIds.has(s.id) ? 'opacity-60' : ''}>
                  <td>
                    <SelectBox label={`Select “${s.title}”`} checked={selected.has(s.id)} onChange={(on) => setSelected((prev) => toggleId(prev, s.id, on))} />
                  </td>
                  <td className="max-w-0 min-w-[9rem] sm:min-w-[12rem]">
                    {renamingId === s.id ? (
                      <RenameInput initial={s.title} onDone={(title) => void rename(s, title)} onCancel={() => setRenamingId(null)} />
                    ) : (
                      <div className="min-w-0">
                        <p className="truncate font-medium text-zinc-900" title={s.title}>
                          {s.title}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                          <span className="font-data truncate">{s.id}</span>
                          {s.archived_at && <Chip tone="muted">Archived</Chip>}
                        </p>
                      </div>
                    )}
                  </td>
                  <td>
                    <SessionStatus status={s.status} />
                  </td>
                  <td className="hidden max-w-[10rem] truncate text-zinc-600 md:table-cell">{agentLabel(s.agent_id)}</td>
                  <td className="hidden text-zinc-600 sm:table-cell">
                    <RelativeTime value={s.last_active_at ?? s.created_at} />
                  </td>
                  <td className="text-right">
                    <RowActions label={`Actions for “${s.title}”`} items={rowActions(s)} />
                  </td>
                </Row>
              ))}
            </tbody>
          </Table>
          <BulkBar count={selectedIds.length} noun="session" onClear={() => setSelected(new Set())}>
            <Button
              size="sm"
              icon={allSelectedArchived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}
              onClick={() => void setArchivedFor(selectedIds, !allSelectedArchived)}
              loading={selectedIds.some((id) => busyIds.has(id))}
            >
              {allSelectedArchived ? 'Restore' : 'Archive'}
            </Button>
            <ConfirmPopover
              size="sm"
              icon={<Trash size={14} />}
              prompt={`Delete ${selectedIds.length} session${selectedIds.length === 1 ? '' : 's'}?`}
              description="Their runs go with them. You can undo for a few seconds."
              onConfirm={() => deleteSessions(selectedIds)}
            >
              Delete
            </ConfirmPopover>
          </BulkBar>
        </>
      )}

      {openId && (
        <SessionSheet
          sessionId={openId}
          listed={openSession}
          agentLabel={agentLabel}
          onClose={() => setOpenId('')}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          actions={(s) => rowActions(s, false)}
          onArchive={(s) => void setArchivedFor([s.id], s.archived_at === null, s.title)}
          refreshToken={refreshToken}
        />
      )}
    </div>
  )
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (title: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial)
  return (
    <Input
      autoFocus
      aria-label="Session title"
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(draft.trim())
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="w-full max-w-md"
    />
  )
}

interface SessionSheetProps {
  sessionId: string
  /** The row as listed (instant header while the detail loads). */
  listed: ChatSession | null
  agentLabel: (id: string | null) => string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  actions: (s: ChatSession) => RowAction[]
  onArchive: (s: ChatSession) => void
  refreshToken: number
}

/** Quick-inspect sheet for one session: facts, its runs, and the way into the
 * full conversation. Deep link: `/sessions?open=<id>`. */
function SessionSheet({ sessionId, listed, agentLabel, onClose, onPrev, onNext, actions, onArchive, refreshToken }: SessionSheetProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api.getSession(sessionId).then(
      (d) => {
        if (!cancelled) setDetail(d)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Could not load this session.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshToken])

  const current = detail?.id === sessionId ? detail : null
  const session: ChatSession | null = current ?? listed
  useDocumentTitle(session?.title ?? null)
  const runs = current ? [...current.runs].sort((a, b) => b.started_at - a.started_at) : null

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Sessions"
      label={session?.title ?? 'Session'}
      title={session?.title ?? 'Session'}
      status={session ? <SessionStatus status={session.status} /> : undefined}
      meta={
        session && (
          <>
            <CopyId value={session.id} label="session ID" />
            <span aria-hidden="true">·</span>
            <span>{agentLabel(session.agent_id)}</span>
            <span aria-hidden="true">·</span>
            <RelativeTime value={session.last_active_at ?? session.created_at} />
          </>
        )
      }
      headerActions={session && <RowActions visibility="always" label={`More actions for “${session.title}”`} items={actions(session)} />}
      footer={
        session && (
          <>
            <Button onClick={() => onArchive(session)} icon={session.archived_at ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}>
              {session.archived_at ? 'Restore' : 'Archive'}
            </Button>
            {session.last_run_id ? (
              <LinkButton to={`/sessions/${session.id}`} variant="primary" icon={<ArrowSquareOut size={14} weight="bold" />}>
                Open conversation
              </LinkButton>
            ) : (
              <Button variant="primary" disabled title="No run yet, so there is nothing to open">
                Open conversation
              </Button>
            )}
          </>
        )
      }
    >
      {error && !session ? (
        <ErrorState message={error} />
      ) : !session ? (
        <SheetSkeleton />
      ) : (
        <>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Created', value: <RelativeTime value={session.created_at} /> },
                { label: 'Last activity', value: <RelativeTime value={session.last_active_at} fallback="Never" /> },
                { label: 'Agent', value: agentLabel(session.agent_id) },
                { label: 'Owner', value: <span className="font-data text-xs">{session.owner_id}</span> },
                { label: 'Archived', value: session.archived_at ? <RelativeTime value={session.archived_at} /> : 'No' },
              ]}
            />
          </SheetSection>
          <SheetSection title={runs ? `Runs · ${runs.length}` : 'Runs'}>
            {runs === null ? (
              error ? (
                <ErrorState message={error} />
              ) : (
                <SheetSkeleton />
              )
            ) : runs.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No runs yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {runs.map((r) => (
                  <li key={r.run_id}>
                    <Link to={`/sessions/${session.id}/runs/${r.run_id}`} className="ui-card ui-card-hover block p-3">
                      <p className="line-clamp-2 text-[13px] text-zinc-900">{r.objective}</p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <StatusBadge status={r.status} />
                        <span className="font-data">{r.run_id}</span>
                        <RelativeTime value={r.started_at} />
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
