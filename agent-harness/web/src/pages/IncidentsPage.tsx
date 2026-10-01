import { ArrowClockwise, Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { IncidentStatusBadge, SeverityBadge } from '../components/incidents/IncidentBadges'
import { PageHeader } from '../components/ui/PageHeader'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Incident } from '../lib/api-types'
import {
  type StatusFilter,
  countByStatus,
  distinctServices,
  filterIncidents,
  nextActions,
  relativeAge,
  statusLabel,
} from '../lib/incident-lifecycle'

const FILTERS: StatusFilter[] = ['all', 'open', 'acknowledged', 'resolved']

function absoluteTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function IncidentsPage() {
  const navigate = useNavigate()
  const { me } = useMe()
  // Until /me resolves, don't flash controls as disabled; the server is the real guard.
  const canMutate = !me || me.permissions.includes('mutate_incidents')
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [service, setService] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .listIncidents()
      .then((data) => {
        if (cancelled) return
        setError(null)
        setIncidents(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load incidents. Check the API is running, then retry.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const refresh = useCallback(() => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }, [])

  const counts = useMemo(() => countByStatus(incidents ?? []), [incidents])
  const services = useMemo(() => distinctServices(incidents ?? []), [incidents])
  // A service filter can outlive the incident that created it (after refresh).
  const activeService = services.includes(service) ? service : ''
  const visible = useMemo(
    () => filterIncidents(incidents ?? [], { status, service: activeService || null }),
    [incidents, status, activeService],
  )

  function acknowledge(incident: Incident) {
    setBusyId(incident.id)
    setActionError(null)
    api
      .acknowledgeIncident(incident.id)
      .then((updated) =>
        setIncidents((prev) => prev?.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)) ?? prev),
      )
      .catch((err: unknown) =>
        setActionError(
          `${incident.id}: ${err instanceof ApiError ? err.message : 'Could not acknowledge. Refresh and try again.'}`,
        ),
      )
      .finally(() => setBusyId(null))
  }

  const reason = disabledReason(me, 'mutate_incidents')

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Incidents"
        description="Raised by agent runs after approval, tracked through open → acknowledged → resolved."
        actions={
          <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary">
            <ArrowClockwise size={14} weight="bold" />
            Refresh
          </button>
        }
      />

      <div className="mt-4">
        {error ? (
          <ErrorBanner message={error} onRetry={refresh} />
        ) : incidents === null ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading incidents">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : incidents.length === 0 ? (
          <EmptyState
            icon={<Warning size={32} weight="duotone" />}
            title="No incidents yet"
            description="When an agent run creates an incident and you approve it, it appears here, linked back to the run. You can then acknowledge and resolve it."
            action={
              <Link to="/chat" className="ui-btn ui-btn-secondary">
                Start a run
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div
                role="group"
                aria-label="Filter by status"
                className="inline-flex rounded-md border border-zinc-300 bg-white p-0.5"
              >
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setStatus(f)}
                    aria-pressed={status === f}
                    className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
                      status === f ? 'bg-sky-600 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    {f === 'all' ? 'All' : statusLabel(f)}
                    <span className="font-data tabular-nums opacity-80">{counts[f]}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="incident-service-filter" className="text-xs font-medium text-zinc-600">
                  Service
                </label>
                <select
                  id="incident-service-filter"
                  name="service"
                  autoComplete="off"
                  value={activeService}
                  onChange={(e) => setService(e.target.value)}
                  className="ui-input"
                >
                  <option value="">All services</option>
                  {services.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {actionError && <ErrorBanner message={actionError} />}

            {visible.length === 0 ? (
              <EmptyState
                icon={<Warning size={32} weight="duotone" />}
                title="No incidents match these filters"
                description="Widen the status or service filter to see the other incidents."
                action={
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    onClick={() => {
                      setStatus('all')
                      setService('')
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              <div className="ui-card overflow-x-auto">
                <table className="ui-table w-full">
                  <thead>
                    <tr>
                      <th scope="col">Severity</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="hidden sm:table-cell">ID</th>
                      <th scope="col">Incident</th>
                      <th scope="col" className="hidden md:table-cell">Opened</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((incident) => {
                      const actions = nextActions(incident.status, canMutate)
                      const readOnly = !canMutate && nextActions(incident.status, true).length > 0
                      return (
                        <tr
                          key={incident.id}
                          onClick={() => navigate(`/incidents/${incident.id}`)}
                          className="cursor-pointer"
                        >
                          <td>
                            <SeverityBadge severity={incident.severity} />
                          </td>
                          <td>
                            <IncidentStatusBadge status={incident.status} />
                          </td>
                          <td className="font-data hidden text-xs text-zinc-500 sm:table-cell">{incident.id}</td>
                          <td className="max-w-[12rem] min-w-0 sm:max-w-md">
                            <Link
                              to={`/incidents/${incident.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="ui-btn-link block truncate"
                              title={incident.title}
                            >
                              {incident.title}
                            </Link>
                            <span className="block truncate text-xs text-zinc-500">
                              {incident.service_name}
                              <span className="md:hidden">
                                {incident.service_name ? ' · ' : ''}opened {relativeAge(incident.created_at)}
                              </span>
                            </span>
                          </td>
                          <td
                            className="hidden text-xs whitespace-nowrap text-zinc-500 md:table-cell"
                            title={absoluteTime(incident.created_at)}
                          >
                            opened {relativeAge(incident.created_at)}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                              {actions.includes('acknowledge') && (
                                <button
                                  type="button"
                                  className="ui-btn ui-btn-sm ui-btn-secondary"
                                  disabled={busyId === incident.id}
                                  onClick={() => acknowledge(incident)}
                                >
                                  Acknowledge
                                </button>
                              )}
                              {actions.includes('resolve') && (
                                <Link to={`/incidents/${incident.id}`} className="ui-btn ui-btn-sm ui-btn-ghost">
                                  Resolve
                                </Link>
                              )}
                              {readOnly && (
                                <span className="text-xs text-zinc-600" title={reason}>
                                  Read-only
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
