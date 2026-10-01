import { Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { StatusBadge } from '../components/StatusBadge'
import { IncidentStatusBadge, SeverityBadge } from '../components/incidents/IncidentBadges'
import { PageHeader } from '../components/ui/PageHeader'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { IncidentDetail, IncidentTimelineEntry } from '../lib/api-types'
import { durationBetween, nextActions, relativeAge, statusLabel } from '../lib/incident-lifecycle'

const NOTE_MAX = 1000

const EVENT_LABELS: Record<IncidentTimelineEntry['event'], string> = {
  opened: 'Opened',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
}

function absoluteTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function IncidentDetailPage() {
  const { incidentId = '' } = useParams<{ incidentId: string }>()
  // Keyed so navigating between incidents (related list) starts with fresh form state.
  return <IncidentDetailView key={incidentId} incidentId={incidentId} />
}

function IncidentDetailView({ incidentId }: { incidentId: string }) {
  const { me } = useMe()
  const canMutate = !me || me.permissions.includes('mutate_incidents')
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .getIncident(incidentId)
      .then((data) => {
        if (cancelled) return
        setLoadError(null)
        setDetail(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setLoadError(err instanceof ApiError ? err.message : 'Failed to load this incident. Check the API is running, then retry.')
      })
    return () => {
      cancelled = true
    }
  }, [incidentId, refreshToken])

  const runAction = useCallback(
    (action: () => Promise<unknown>, fallback: string) => {
      setBusy(true)
      setActionError(null)
      action()
        .then(() => api.getIncident(incidentId))
        .then((fresh) => {
          setDetail(fresh)
          setConfirming(false)
          setNote('')
        })
        .catch((err: unknown) => {
          setActionError(err instanceof ApiError ? err.message : fallback)
          setConfirming(false)
        })
        .finally(() => setBusy(false))
    },
    [incidentId],
  )

  if (notFound) {
    return (
      <div className="mx-auto max-w-6xl">
        <EmptyState
          icon={<Warning size={32} weight="duotone" />}
          title="Incident not found"
          description="It may not exist, or it belongs to another user's run. Only the run owner and admins can open it."
          action={
            <Link to="/incidents" className="ui-btn ui-btn-secondary">
              All incidents
            </Link>
          }
        />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-6xl">
        <ErrorBanner message={loadError} onRetry={() => {
            setLoadError(null)
            setRefreshToken((n) => n + 1)
          }} />
      </div>
    )
  }

  if (detail === null) {
    return (
      <div className="mx-auto max-w-6xl space-y-3" aria-busy="true" aria-label="Loading incident">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    )
  }

  const actions = nextActions(detail.status, canMutate)
  const terminal = nextActions(detail.status, true).length === 0
  const reason = disabledReason(me, 'mutate_incidents')
  const timeToAck =
    detail.acknowledged_at ? durationBetween(detail.created_at, detail.acknowledged_at) : ''
  const timeToResolve = detail.resolved_at ? durationBetween(detail.created_at, detail.resolved_at) : ''
  const noteId = 'incident-resolution-note'

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/incidents', label: 'All incidents' }}
        title={detail.title}
        meta={
          <>
            <span className="font-data">{detail.id}</span>
            <SeverityBadge severity={detail.severity} />
            <IncidentStatusBadge status={detail.status} />
            {detail.service_name && <span>Service: {detail.service_name}</span>}
            {timeToAck && (
              <span>
                Time to acknowledge <span className="font-data tabular-nums">{timeToAck}</span>
              </span>
            )}
            {timeToResolve && (
              <span>
                Time to resolve <span className="font-data tabular-nums">{timeToResolve}</span>
              </span>
            )}
          </>
        }
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <section className="ui-card p-4" aria-labelledby="incident-description">
            <h2 id="incident-description" className="text-sm font-semibold text-zinc-900">
              Description
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 [overflow-wrap:anywhere]">
              {detail.description || 'No description was provided.'}
            </p>
          </section>

          <section className="ui-card p-4" aria-labelledby="incident-timeline">
            <h2 id="incident-timeline" className="text-sm font-semibold text-zinc-900">
              Timeline
            </h2>
            <ol className="mt-3">
              {detail.timeline.map((entry, index) => (
                <li key={`${entry.event}-${entry.at}`} className="relative flex gap-3 pb-4 last:pb-0">
                  {index < detail.timeline.length - 1 && (
                    <span className="absolute top-3 bottom-0 left-[5px] w-px bg-zinc-200" aria-hidden="true" />
                  )}
                  <span
                    className="relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-sky-600 bg-white"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-900">
                      <span className="font-medium">{EVENT_LABELS[entry.event]}</span>
                      {entry.actor_name && <span className="text-zinc-700"> by {entry.actor_name}</span>}
                    </p>
                    <p className="text-xs text-zinc-600">
                      <time dateTime={entry.at}>{absoluteTime(entry.at)}</time> · {relativeAge(entry.at)}
                    </p>
                    {entry.note && (
                      <p className="mt-1 rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm text-zinc-700 [overflow-wrap:anywhere] whitespace-pre-wrap">
                        {entry.note}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          <section className="ui-card p-4" aria-labelledby="incident-actions">
            <h2 id="incident-actions" className="text-sm font-semibold text-zinc-900">
              Actions
            </h2>
            {terminal ? (
              <p className="mt-2 text-sm text-zinc-700">
                This incident is {statusLabel(detail.status).toLowerCase()}. Resolved incidents can&apos;t be reopened;
                raise a new one if the problem returns.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {!canMutate && <p className="text-sm text-zinc-700">{reason}</p>}
                {detail.status === 'open' && (
                  <button
                    type="button"
                    className={`ui-btn w-full ${confirming ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
                    disabled={busy || !canMutate || !actions.includes('acknowledge')}
                    title={canMutate ? undefined : reason}
                    onClick={() =>
                      runAction(() => api.acknowledgeIncident(detail.id), 'Could not acknowledge. Refresh and try again.')
                    }
                  >
                    Acknowledge
                  </button>
                )}
                <div>
                  <label htmlFor={noteId} className="text-xs font-medium text-zinc-700">
                    Resolution note (optional)
                  </label>
                  <textarea
                    id={noteId}
                    name="resolution-note"
                    autoComplete="off"
                    rows={3}
                    maxLength={NOTE_MAX}
                    value={note}
                    disabled={busy || !canMutate}
                    onChange={(e) => {
                      setNote(e.target.value)
                      setConfirming(false)
                    }}
                    placeholder="What fixed it?"
                    className="ui-input mt-1 w-full"
                  />
                  <p className="mt-1 text-right text-xs text-zinc-600 tabular-nums">
                    {note.length}/{NOTE_MAX}
                  </p>
                </div>
                {confirming ? (
                  <div className="space-y-2 rounded border border-zinc-300 bg-zinc-50 p-3">
                    <p className="text-sm text-zinc-800">Resolve this incident? It can&apos;t be reopened.</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-primary"
                        disabled={busy}
                        onClick={() =>
                          runAction(
                            () => api.resolveIncident(detail.id, note.trim()),
                            'Could not resolve. Refresh and try again.',
                          )
                        }
                      >
                        Confirm resolve
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-ghost"
                        disabled={busy}
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`ui-btn w-full ${detail.status === 'open' ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
                    disabled={busy || !canMutate || !actions.includes('resolve')}
                    title={canMutate ? undefined : reason}
                    onClick={() => setConfirming(true)}
                  >
                    Resolve
                  </button>
                )}
              </div>
            )}
            {actionError && (
              <div className="mt-3">
                <ErrorBanner message={actionError} />
              </div>
            )}
          </section>

          <section className="ui-card p-4" aria-labelledby="incident-run">
            <h2 id="incident-run" className="text-sm font-semibold text-zinc-900">
              Originating run
            </h2>
            {detail.run ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm text-zinc-800 [overflow-wrap:anywhere]">{detail.run.objective}</p>
                <StatusBadge status={detail.run.status} />
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <Link to={`/runs/${detail.run.run_id}`} className="ui-btn-link font-data">
                    {detail.run.run_id}
                  </Link>
                  {detail.run.session_id && (
                    <span className="text-zinc-600">
                      Session <span className="font-data">{detail.run.session_id}</span>
                    </span>
                  )}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-zinc-700">
                {detail.run_id
                  ? 'The run that raised this incident no longer exists.'
                  : 'This incident was not raised by a run.'}
              </p>
            )}
          </section>

          {detail.related_open.length > 0 && (
            <section className="ui-card p-4" aria-labelledby="incident-related">
              <h2 id="incident-related" className="text-sm font-semibold text-zinc-900">
                Related open incidents for {detail.service_name}
              </h2>
              <ul className="mt-2 space-y-2">
                {detail.related_open.map((related) => (
                  <li key={related.id} className="min-w-0">
                    <Link to={`/incidents/${related.id}`} className="ui-btn-link block truncate text-sm" title={related.title}>
                      {related.title}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-zinc-600">
                      <span className="font-data">{related.id}</span>
                      <SeverityBadge severity={related.severity} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
