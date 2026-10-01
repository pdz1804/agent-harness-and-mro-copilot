import { ArrowClockwise, ArrowSquareOut, Copy, Pulse } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { IncidentStatusBadge, SeverityBadge } from '../components/incidents/IncidentBadges'
import {
  Button,
  Card,
  Chip,
  CopyId,
  EmptyState,
  ErrorState,
  Field,
  FactList,
  FilteredEmpty,
  LinkButton,
  PageHeader,
  RelativeTime,
  Row,
  RowActions,
  SearchInput,
  Segmented,
  Select,
  Sheet,
  SheetSection,
  SheetSkeleton,
  SortHeader,
  Table,
  TableSkeleton,
  useToast,
  type ChipTone,
  type RowAction,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { disabledReason, useMe } from '../hooks/useMe'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Incident, Service, ServiceStatus } from '../lib/api-types'
import {
  SERVICE_SORT_COLUMNS,
  SERVICE_STATUSES,
  type ServiceStatusFilter,
  activeIncidentCounts,
  countServiceStatuses,
  filterServices,
  formatErrorRate,
  formatLatency,
  serviceSortKey,
  serviceStatusLabel,
} from '../lib/services-state'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'

const STATUS_VALUES: ServiceStatusFilter[] = ['all', ...SERVICE_STATUSES]
const FILTER_KEYS = ['q', 'status', 'sort']
const STATUS_TONE: Record<ServiceStatus, ChipTone> = { operational: 'ok', degraded: 'warn', down: 'danger' }

function ServiceStatusChip({ status }: { status: ServiceStatus }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {serviceStatusLabel(status)}
    </Chip>
  )
}

/** `last_deploy` is free text from the registry: a date reads relative, anything else shows as is. */
function Deploy({ value }: { value: string | null }) {
  if (!value) return <span>—</span>
  return Number.isNaN(Date.parse(value)) ? <span>{value}</span> : <RelativeTime value={value} />
}

/** Services: the mock registry the agent investigates. Flip a status to stage
 * a scenario; every change toasts with Undo (set the previous status back).
 * Filters, sort and the open service sheet (`?open=<name>`) live in the URL. */
export function ServicesPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  const canMutate = !me || me.permissions.includes('mutate_services')
  const reason = disabledReason(me, 'mutate_services')

  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlEnum<ServiceStatusFilter>('status', STATUS_VALUES, 'all')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openName, setOpenName] = useUrlState('open')
  const clearParams = useClearUrlParams()

  const [services, setServices] = useState<Service[] | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [updating, setUpdating] = useState<Set<string>>(() => new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setServices(await api.listServices())
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      setError(errorText(err, 'Failed to load services. Check the API is running, then retry.'))
    }
    // Incident counts are a nicety: the table works without them.
    api.listIncidents().then(setIncidents, () => undefined)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sort = parseSort(sortRaw, SERVICE_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const counts = useMemo(() => countServiceStatuses(services ?? []), [services])
  const incidentCounts = useMemo(() => activeIncidentCounts(incidents), [incidents])
  const totalActive = useMemo(() => [...incidentCounts.values()].reduce((a, b) => a + b, 0), [incidentCounts])
  const rows = useMemo(
    () => sortRows(filterServices(services ?? [], { status, query: q }), sort, serviceSortKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, status, q, sortRaw],
  )
  const active = status !== 'all' || !!q

  const replace = (updated: Service) => setServices((prev) => prev && prev.map((s) => (s.name === updated.name ? updated : s)))

  /** Set a status (real call, pending on the exact control); Undo sets the previous one back. */
  const setStatusFor = async (svc: Service, next: ServiceStatus) => {
    if (next === svc.status) return
    const previous = svc.status
    setUpdating((prev) => new Set(prev).add(svc.name))
    try {
      replace(await api.setServiceStatus(svc.name, next))
      toast({
        title: `${svc.name} set to ${next}`,
        description: `Was ${previous}.`,
        action: {
          label: 'Undo',
          run: async () => {
            replace(await api.setServiceStatus(svc.name, previous))
          },
        },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't update ${svc.name}`, description: errorText(err, 'Try again.') })
    } finally {
      setUpdating((prev) => {
        const nextSet = new Set(prev)
        nextSet.delete(svc.name)
        return nextSet
      })
    }
  }

  const clearFilters = () => clearParams(FILTER_KEYS)
  const statusSelect = (svc: Service, labelled = true) => (
    <Select
      aria-label={labelled ? `Set status for ${svc.name}` : undefined}
      value={svc.status}
      disabled={updating.has(svc.name) || !canMutate}
      aria-busy={updating.has(svc.name) || undefined}
      title={canMutate ? undefined : reason}
      onChange={(e) => void setStatusFor(svc, e.target.value as ServiceStatus)}
      className="w-[8.5rem]"
    >
      {SERVICE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {serviceStatusLabel(s)}
        </option>
      ))}
    </Select>
  )

  const rowActions = (svc: Service): RowAction[] => [
    { label: 'View incidents', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/incidents?service=${encodeURIComponent(svc.name)}`) },
    {
      label: 'Copy name',
      icon: <Copy size={14} />,
      onSelect: () =>
        navigator.clipboard?.writeText(svc.name).then(
          () => toast({ title: `Copied ${svc.name}` }),
          () => toast({ tone: 'error', title: "Couldn't copy the name" }),
        ),
    },
  ]

  const degraded = (services ?? []).filter((s) => s.status === 'degraded')
  const down = (services ?? []).filter((s) => s.status === 'down')
  const openIndex = rows.findIndex((s) => s.name === openName)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setOpenName(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].name)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Services"
        description="The mock service registry, persisted in PostgreSQL. Flip a status to stage a scenario for the agent to investigate."
        actions={
          <>
            <Button icon={<ArrowClockwise size={14} weight="bold" />} loading={loading} onClick={() => void load()}>
              Refresh
            </Button>
            <LinkButton to="/chat" variant="primary">
              Investigate in a run
            </LinkButton>
          </>
        }
        toolbar={
          <>
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              options={STATUS_VALUES.map((v) => ({ value: v, label: v === 'all' ? 'All' : serviceStatusLabel(v), count: counts[v] }))}
            />
            <SearchInput label="Search services" placeholder="Search name or owner" value={q} onValueChange={setQ} className="w-full sm:w-60" />
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-zinc-500" aria-live="polite">
              {updatedAt ? (
                <>
                  Updated <RelativeTime value={updatedAt} />
                </>
              ) : null}
            </span>
          </>
        }
      />

      {error && services === null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : services === null ? (
        <TableSkeleton rows={5} columns={6} />
      ) : services.length === 0 ? (
        <EmptyState
          icon={<Pulse size={22} weight="duotone" />}
          title="No services in the registry"
          description="The registry is seeded when the API starts. Once services exist you can flip their status here to stage a scenario."
          action={
            <Button variant="primary" onClick={() => void load()}>
              Reload registry
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <p className="text-xs text-zinc-500">Operational</p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tabular-nums text-zinc-950">
                {counts.operational}
                <span className="text-sm font-normal text-zinc-500"> / {counts.all}</span>
              </p>
            </Card>
            <Card>
              <p className="text-xs text-zinc-500">Degraded</p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tabular-nums text-zinc-950">{counts.degraded}</p>
              <p className="mt-1.5 truncate text-xs text-amber-700">{degraded.map((s) => s.name).join(', ') || 'None'}</p>
            </Card>
            <Card>
              <p className="text-xs text-zinc-500">Down</p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tabular-nums text-zinc-950">{counts.down}</p>
              <p className="mt-1.5 truncate text-xs text-rose-700">{down.map((s) => s.name).join(', ') || 'None'}</p>
            </Card>
            <Card>
              <p className="text-xs text-zinc-500">Active incidents</p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tabular-nums text-zinc-950">{totalActive}</p>
              <p className="mt-1.5 text-xs text-zinc-500">Open or acknowledged</p>
            </Card>
          </div>

          {error && <p className="mb-2 text-xs text-rose-700">Refresh failed: {error} Showing the last loaded list.</p>}
          {rows.length === 0 ? (
            <FilteredEmpty query={q || undefined} what="services" onClear={clearFilters} />
          ) : (
            <Table label="Services">
              <thead>
                <tr>
                  <SortHeader column="name" sort={sort} onSort={onSort}>
                    Service
                  </SortHeader>
                  <SortHeader column="status" sort={sort} onSort={onSort}>
                    Status
                  </SortHeader>
                  <th>Set status</th>
                  <SortHeader column="latency" sort={sort} onSort={onSort} className="hidden md:table-cell">
                    Latency
                  </SortHeader>
                  <SortHeader column="error_rate" sort={sort} onSort={onSort} className="hidden md:table-cell">
                    Error rate
                  </SortHeader>
                  <SortHeader column="deploy" sort={sort} onSort={onSort} className="hidden lg:table-cell">
                    Last deploy
                  </SortHeader>
                  <th className="w-12">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((svc) => (
                  <Row key={svc.name} onOpen={() => setOpenName(svc.name)} selected={svc.name === openName} className={updating.has(svc.name) ? 'opacity-70' : ''}>
                    <td className="max-w-0 min-w-[9rem]">
                      <p className="font-data truncate text-[13px] text-zinc-900">{svc.name}</p>
                      <p className="truncate text-xs text-zinc-500">
                        {svc.owner ?? 'Unowned'}
                        {incidentCounts.get(svc.name) ? ` · ${incidentCounts.get(svc.name)} active incident${incidentCounts.get(svc.name) === 1 ? '' : 's'}` : ''}
                      </p>
                    </td>
                    <td>
                      <ServiceStatusChip status={svc.status} />
                    </td>
                    <td>{statusSelect(svc)}</td>
                    <td className="hidden text-zinc-600 tabular-nums md:table-cell">{formatLatency(svc.latency_ms)}</td>
                    <td className="hidden text-zinc-600 tabular-nums md:table-cell">{formatErrorRate(svc.error_rate)}</td>
                    <td className="hidden text-zinc-600 lg:table-cell">
                      <Deploy value={svc.last_deploy} />
                    </td>
                    <td className="text-right">
                      <RowActions label={`Actions for ${svc.name}`} items={rowActions(svc)} />
                    </td>
                  </Row>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}

      {openName && (
        <ServiceSheet
          name={openName}
          service={(services ?? []).find((s) => s.name === openName) ?? null}
          loaded={services !== null}
          incidentCount={incidentCounts.get(openName) ?? 0}
          statusControl={(svc) => (
            <Field label="Change status to" hint={canMutate ? 'Changes apply immediately and can be undone for a few seconds.' : reason}>
              {(field) => (
                <Select
                  id={field.id}
                  aria-describedby={field['aria-describedby']}
                  value={svc.status}
                  disabled={updating.has(svc.name) || !canMutate}
                  aria-busy={updating.has(svc.name) || undefined}
                  title={canMutate ? undefined : reason}
                  onChange={(e) => void setStatusFor(svc, e.target.value as ServiceStatus)}
                  className="w-full"
                >
                  {SERVICE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {serviceStatusLabel(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          actions={rowActions}
          onClose={() => setOpenName('')}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
        />
      )}
    </div>
  )
}

interface ServiceSheetProps {
  name: string
  service: Service | null
  /** False until the first list load finishes (shows a skeleton, not "not found"). */
  loaded: boolean
  incidentCount: number
  statusControl: (svc: Service) => ReactNode
  actions: (svc: Service) => RowAction[]
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}

/** Quick-inspect sheet for one service: health facts, the status control and
 * its incidents. Deep link: `/services?open=<name>`. */
function ServiceSheet({ name, service, loaded, incidentCount, statusControl, actions, onClose, onPrev, onNext }: ServiceSheetProps) {
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [incidentError, setIncidentError] = useState<string | null>(null)
  useDocumentTitle(name)

  useEffect(() => {
    let cancelled = false
    setIncidents(null)
    setIncidentError(null)
    api.listIncidents({ service: name }).then(
      (list) => {
        if (!cancelled) setIncidents(list)
      },
      (err: unknown) => {
        if (!cancelled) setIncidentError(errorText(err, 'Could not load incidents for this service.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [name, incidentCount])

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Services"
      title={name}
      status={service ? <ServiceStatusChip status={service.status} /> : undefined}
      meta={
        service && (
          <>
            <CopyId value={service.name} label="service name" />
            <span aria-hidden="true">·</span>
            <span>{service.owner ?? 'Unowned'}</span>
            {service.last_checked && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Checked <RelativeTime value={service.last_checked} />
                </span>
              </>
            )}
          </>
        )
      }
      headerActions={service && <RowActions visibility="always" label={`More actions for ${service.name}`} items={actions(service)} />}
      footer={
        service && (
          <LinkButton to={`/incidents?service=${encodeURIComponent(service.name)}`} variant="primary" icon={<ArrowSquareOut size={14} weight="bold" />}>
            View all incidents
          </LinkButton>
        )
      }
    >
      {!service ? (
        loaded ? <ErrorState message={`No service named “${name}” in the registry.`} /> : <SheetSkeleton />
      ) : (
        <>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Owner', value: service.owner ?? 'Unowned' },
                { label: 'Latency', value: <span className="tabular-nums">{formatLatency(service.latency_ms)}</span> },
                { label: 'Error rate', value: <span className="tabular-nums">{formatErrorRate(service.error_rate)}</span> },
                { label: 'Last deploy', value: <Deploy value={service.last_deploy} /> },
                { label: 'Last checked', value: <RelativeTime value={service.last_checked} /> },
              ]}
            />
          </SheetSection>
          <SheetSection title="Set status">{statusControl(service)}</SheetSection>
          <SheetSection title={incidents ? `Incidents · ${incidents.length}` : 'Incidents'}>
            {incidentError ? (
              <ErrorState message={incidentError} />
            ) : incidents === null ? (
              <SheetSkeleton />
            ) : incidents.length === 0 ? (
              <p className="text-[13px] text-zinc-500">No incidents for this service.</p>
            ) : (
              <ul className="space-y-1.5">
                {incidents.map((i) => (
                  <li key={i.id}>
                    <Card as="div" padding="sm">
                      <LinkButton to={`/incidents?open=${encodeURIComponent(i.id)}`} variant="link" className="block max-w-full truncate text-[13px]" title={i.title}>
                        {i.title}
                      </LinkButton>
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <SeverityBadge severity={i.severity} />
                        <IncidentStatusBadge status={i.status} />
                        <RelativeTime value={i.created_at} />
                      </p>
                    </Card>
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
