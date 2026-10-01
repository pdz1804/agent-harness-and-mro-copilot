import { ArrowSquareOut, CheckCircle, Copy, PlayCircle, Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IncidentStatusBadge, SeverityBadge } from '../components/incidents/IncidentBadges'
import { IncidentSheet } from '../components/incidents/IncidentSheet'
import { useIncidentActions, useIncidentOverrides } from '../components/incidents/use-incident-actions'
import {
  BulkBar,
  Button,
  CopyId,
  EmptyState,
  ErrorState,
  FilteredEmpty,
  LinkButton,
  PageHeader,
  RelativeTime,
  Row,
  RowActions,
  SearchInput,
  Segmented,
  Select,
  SelectBox,
  SortHeader,
  Table,
  TableSkeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { disabledReason, useMe } from '../hooks/useMe'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Incident } from '../lib/api-types'
import { pruneSelection, toggleId } from '../lib/bulk'
import {
  INCIDENT_SORT_COLUMNS,
  SEVERITIES,
  type StatusFilter,
  countByStatus,
  distinctServices,
  filterIncidents,
  incidentSortKey,
  nextActions,
} from '../lib/incident-lifecycle'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const STATUS_VALUES: StatusFilter[] = ['all', 'open', 'acknowledged', 'resolved']
const FILTER_KEYS = ['q', 'status', 'severity', 'service', 'sort']
const SEARCH_DEBOUNCE_MS = 250
const DEFAULT_SORT = { column: 'opened', dir: 'desc' } as const

/** Incidents: filterable, sortable table; a row opens a sheet (`?open=<id>`)
 * and `/incidents/:id` stays the full-page view. Acknowledge has no reverse
 * transition in the API, so it is optimistic and held for the Undo window;
 * resolve is a real call whose Undo reopens the incident. */
export function IncidentsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  // Until /me resolves, don't flash controls as disabled; the server is the real guard.
  const canMutate = !me || me.permissions.includes('mutate_incidents')
  const reason = disabledReason(me, 'mutate_incidents')

  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlEnum<StatusFilter>('status', STATUS_VALUES, 'all')
  const [severity, setSeverity] = useUrlState('severity')
  const [service, setService] = useUrlState('service')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openId, setOpenId] = useUrlState('open')
  const clearParams = useClearUrlParams()

  const [searchInput, setSearchInput] = useState(q)
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const { setOverride, clearOverride, merge } = useIncidentOverrides()

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== q) setQ(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, q, setQ])

  // Keep the box in step when the URL changes underneath it (Back, Clear filters).
  useEffect(() => setSearchInput(q), [q])

  const load = useCallback(async () => {
    try {
      const data = await api.listIncidents()
      setIncidents(data)
      setError(null)
    } catch (err) {
      setError(errorText(err, 'Failed to load incidents. Check the API is running, then retry.'))
    }
    setRefreshToken((n) => n + 1)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const { acknowledge, resolve } = useIncidentActions({ setOverride, clearOverride, reload: load })

  const merged = useMemo(() => (incidents ?? []).map(merge), [incidents, merge])
  const counts = useMemo(() => countByStatus(merged), [merged])
  const services = useMemo(() => distinctServices(merged), [merged])
  const sort = parseSort(sortRaw, INCIDENT_SORT_COLUMNS) ?? DEFAULT_SORT
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const active = status !== 'all' || !!severity || !!service || !!q
  const rows = useMemo(
    () => sortRows(filterIncidents(merged, { status, service: service || null, severity: severity || null, query: q }), sort, incidentSortKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [merged, status, service, severity, q, sortRaw],
  )

  useEffect(() => {
    if (incidents) setSelected((prev) => pruneSelection(prev, rows.map((i) => i.id)))
  }, [incidents, rows])

  const clearFilters = () => {
    setSearchInput('')
    clearParams(FILTER_KEYS)
  }

  const selectedRows = rows.filter((i) => selected.has(i.id))
  const selectedOpen = selectedRows.filter((i) => i.status === 'open')
  const allSelected = rows.length > 0 && selectedRows.length === rows.length

  const openIndex = rows.findIndex((i) => i.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].id)
  }

  const copyId = (id: string) =>
    navigator.clipboard?.writeText(id).then(
      () => toast({ title: `Copied ${id}` }),
      () => toast({ tone: 'error', title: "Couldn't copy the ID" }),
    )

  const rowActions = (i: Incident): RowAction[] => {
    const forward = nextActions(i.status, canMutate)
    return [
      {
        label: 'Acknowledge',
        icon: <PlayCircle size={14} />,
        disabled: !forward.includes('acknowledge'),
        disabledReason: !canMutate ? reason : i.status !== 'open' ? 'Only open incidents can be acknowledged.' : undefined,
        onSelect: () => acknowledge([i]),
      },
      {
        label: 'Resolve…',
        icon: <CheckCircle size={14} />,
        disabled: !forward.includes('resolve'),
        disabledReason: !canMutate ? reason : 'This incident is already resolved.',
        onSelect: () => setOpenId(i.id),
      },
      { label: 'Copy ID', icon: <Copy size={14} />, onSelect: () => copyId(i.id) },
      { label: 'Open full page', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/incidents/${i.id}`) },
      ...(i.run_id ? [{ label: 'View originating run', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/runs/${i.run_id}`) }] : []),
    ]
  }

  const listed = merged.find((i) => i.id === openId) ?? null

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Incidents"
        description="Opened by agent runs after approval. Acknowledge to take ownership, resolve with a note."
        actions={
          <LinkButton to="/chat" variant="primary">
            Start a run
          </LinkButton>
        }
        toolbar={
          <>
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              options={STATUS_VALUES.map((v) => ({ value: v, label: v === 'all' ? 'All' : v[0].toUpperCase() + v.slice(1), count: counts[v] }))}
            />
            <SearchInput label="Search incidents" placeholder="Search title, ID or service" value={searchInput} onValueChange={setSearchInput} className="w-full sm:w-60" />
            <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
            <Select aria-label="Service" value={services.includes(service) ? service : ''} onChange={(e) => setService(e.target.value)} className="max-w-[12rem]">
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-zinc-500" aria-live="polite">
              {incidents ? `${rows.length} of ${incidents.length}` : ''}
            </span>
          </>
        }
      />

      {error && incidents === null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : incidents === null ? (
        <TableSkeleton rows={6} columns={6} />
      ) : incidents.length === 0 ? (
        <EmptyState
          icon={<Warning size={22} weight="duotone" />}
          title="No incidents yet"
          description="When an agent run raises an incident and you approve it, it appears here, linked back to the run. You can then acknowledge and resolve it."
          action={
            <LinkButton to="/chat" variant="primary">
              Start a run
            </LinkButton>
          }
          example="Try: “payments-api looks degraded. Open an incident if it is.”"
        />
      ) : rows.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="incidents" onClear={clearFilters} />
      ) : (
        <>
          {error && <p className="mb-2 text-xs text-rose-700">Refresh failed: {error} Showing the last loaded list.</p>}
          <Table label="Incidents">
            <thead>
              <tr>
                <th className="w-10">
                  <SelectBox
                    label="Select all incidents"
                    checked={allSelected}
                    indeterminate={selectedRows.length > 0}
                    onChange={(on) => setSelected(on ? new Set(rows.map((i) => i.id)) : new Set())}
                  />
                </th>
                <SortHeader column="title" sort={sort} onSort={onSort}>
                  Incident
                </SortHeader>
                <SortHeader column="severity" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                  Severity
                </SortHeader>
                <SortHeader column="status" sort={sort} onSort={onSort}>
                  Status
                </SortHeader>
                <SortHeader column="service" sort={sort} onSort={onSort} className="hidden md:table-cell">
                  Service
                </SortHeader>
                <SortHeader column="opened" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                  Opened
                </SortHeader>
                <th className="hidden lg:table-cell">Acknowledged</th>
                <th className="w-12">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <Row key={i.id} onOpen={() => setOpenId(i.id)} selected={selected.has(i.id) || i.id === openId}>
                  <td>
                    <SelectBox label={`Select ${i.id}`} checked={selected.has(i.id)} onChange={(on) => setSelected((prev) => toggleId(prev, i.id, on))} />
                  </td>
                  <td className="max-w-0 min-w-[9rem]">
                    <p className="truncate font-medium text-zinc-900" title={i.title}>
                      {i.title}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                      <CopyId value={i.id} label="incident ID" />
                      <span className="sm:hidden"><SeverityBadge severity={i.severity} /></span>
                    </p>
                  </td>
                  <td className="hidden sm:table-cell">
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td>
                    <IncidentStatusBadge status={i.status} />
                  </td>
                  <td className="hidden max-w-[10rem] truncate text-zinc-600 md:table-cell">{i.service_name ?? '—'}</td>
                  <td className="hidden text-zinc-600 sm:table-cell">
                    <RelativeTime value={i.created_at} />
                  </td>
                  <td className="hidden text-zinc-600 lg:table-cell">
                    <RelativeTime value={i.acknowledged_at} fallback="Not yet" />
                  </td>
                  <td className="text-right">
                    <RowActions label={`Actions for ${i.id}`} items={rowActions(i)} />
                  </td>
                </Row>
              ))}
            </tbody>
          </Table>
          <BulkBar count={selectedRows.length} noun="incident" onClear={() => setSelected(new Set())}>
            <Button
              size="sm"
              icon={<PlayCircle size={14} />}
              disabled={!canMutate || selectedOpen.length === 0}
              title={!canMutate ? reason : selectedOpen.length === 0 ? 'None of the selected incidents are open.' : undefined}
              onClick={() => {
                acknowledge(selectedOpen)
                setSelected(new Set())
              }}
            >
              {selectedOpen.length > 0 ? `Acknowledge ${selectedOpen.length} open` : 'Acknowledge'}
            </Button>
          </BulkBar>
        </>
      )}

      {openId && (
        <IncidentSheet
          incidentId={openId}
          listed={listed}
          merge={merge}
          canMutate={canMutate}
          reason={reason}
          refreshToken={refreshToken}
          onClose={() => setOpenId('')}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          onOpenOther={setOpenId}
          onAcknowledge={(i) => acknowledge([i])}
          onResolve={resolve}
        />
      )}
    </div>
  )
}
