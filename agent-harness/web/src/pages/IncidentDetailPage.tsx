import { ArrowCounterClockwise, CheckCircle, PlayCircle, Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IncidentStatusRow, IncidentTimeline, OriginRun, RelatedIncidents, ResolveNoteField } from '../components/incidents/IncidentParts'
import { useIncidentActions, useIncidentOverrides } from '../components/incidents/use-incident-actions'
import { Button, Card, CardHeader, CopyId, EmptyState, ErrorState, LinkButton, RelativeTime, Skeleton } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api, errorText } from '../lib/api'
import type { IncidentDetail } from '../lib/api-types'
import { nextActions, resolutionNoteError, statusLabel } from '../lib/incident-lifecycle'
import { PageHeader } from '../components/ui'

export function IncidentDetailPage() {
  const { incidentId = '' } = useParams<{ incidentId: string }>()
  // Keyed so navigating between incidents (related list) starts with fresh form state.
  return <IncidentDetailView key={incidentId} incidentId={incidentId} />
}

/** The full-page incident view (`/incidents/:id`): the same facts, timeline
 * and actions as the sheet, with room for the originating run and related
 * incidents. Acknowledge is optimistic with Undo; resolve toasts with an Undo
 * that reopens. */
function IncidentDetailView({ incidentId }: { incidentId: string }) {
  const { me } = useMe()
  const canMutate = !me || me.permissions.includes('mutate_incidents')
  const reason = disabledReason(me, 'mutate_incidents')
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [reopening, setReopening] = useState(false)
  const [touched, setTouched] = useState(false)
  const [resolving, setResolving] = useState(false)
  const { setOverride, clearOverride, merge } = useIncidentOverrides()

  const load = useCallback(async () => {
    try {
      setDetail(await api.getIncident(incidentId))
      setLoadError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true)
      else setLoadError(errorText(err, 'Failed to load this incident. Check the API is running, then retry.'))
    }
  }, [incidentId])

  useEffect(() => {
    void load()
  }, [load])

  const { acknowledge, resolve, reopen } = useIncidentActions({ setOverride, clearOverride, reload: load })
  const incident = detail ? merge(detail) : null
  useDocumentTitle(incident?.title ?? null)

  if (notFound) {
    return (
      <div className="mx-auto max-w-6xl">
        <EmptyState
          icon={<Warning size={22} weight="duotone" />}
          title="Incident not found"
          description="It may not exist, or it belongs to another user's run. Only the run owner and admins can open it."
          action={
            <LinkButton to="/incidents" variant="secondary">
              All incidents
            </LinkButton>
          }
        />
      </div>
    )
  }

  if (loadError && !detail) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader back={{ to: '/incidents', label: 'All incidents' }} title="Incident" />
        <ErrorState message={loadError} onRetry={() => void load()} />
      </div>
    )
  }

  if (!detail || !incident) {
    return (
      <div className="mx-auto max-w-6xl" aria-busy="true" aria-label="Loading incident">
        <PageHeader back={{ to: '/incidents', label: 'All incidents' }} title="Incident" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <Skeleton className="h-28 w-full rounded-[14px]" />
            <Skeleton className="h-48 w-full rounded-[14px]" />
          </div>
          <Skeleton className="h-56 w-full rounded-[14px]" />
        </div>
      </div>
    )
  }

  const actions = nextActions(incident.status, canMutate)
  const terminal = nextActions(incident.status, true).length === 0
  const noteError = touched ? resolutionNoteError(note) : null

  const submitResolve = async () => {
    setTouched(true)
    if (resolutionNoteError(note)) return
    setResolving(true)
    const ok = await resolve(incident, note)
    setResolving(false)
    if (ok) {
      setNote('')
      setTouched(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/incidents', label: 'All incidents' }}
        title={incident.title}
        meta={
          <>
            <CopyId value={incident.id} label="incident ID" />
            <IncidentStatusRow detail={incident} />
            {incident.service_name && <span>Service: {incident.service_name}</span>}
            <span>
              Opened <RelativeTime value={incident.created_at} />
            </span>
          </>
        }
        actions={
          <LinkButton to={`/incidents?open=${encodeURIComponent(incident.id)}`} variant="secondary">
            Open in list
          </LinkButton>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Card as="section" aria-label="Description">
            <CardHeader title="Description" />
            <p className="mt-2 text-sm whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere]">{incident.description || 'No description was provided.'}</p>
          </Card>
          <Card as="section" aria-label="Timeline">
            <CardHeader title="Timeline" />
            <div className="mt-3">
              <IncidentTimeline entries={detail.timeline} />
            </div>
          </Card>
        </div>

        <aside className="min-w-0 space-y-4">
          <Card as="section" aria-label="Actions">
            <CardHeader title="Actions" />
            {terminal ? (
              <div className="mt-2 space-y-2 text-sm text-zinc-700">
                <p>This incident is {statusLabel(incident.status).toLowerCase()}.</p>
                {incident.resolution_note && <p className="rounded-[10px] bg-zinc-950/[0.04] px-2.5 py-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{incident.resolution_note}</p>}
                <p className="text-xs text-zinc-500">Resolved by mistake, or the problem came back? Reopen it; it returns to acknowledged.</p>
                {incident.status === 'resolved' && (
                  <div className="flex justify-end">
                    <Button
                      icon={<ArrowCounterClockwise size={14} />}
                      loading={reopening}
                      disabled={!canMutate || reopening}
                      title={canMutate ? undefined : reason}
                      onClick={() => {
                        setReopening(true)
                        void reopen(incident).finally(() => setReopening(false))
                      }}
                    >
                      Reopen
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {!canMutate && <p className="text-[13px] text-zinc-600">{reason}</p>}
                <ResolveNoteField value={note} onChange={setNote} onBlur={() => setTouched(true)} error={noteError} disabled={!canMutate || resolving} title={canMutate ? undefined : reason} />
                <div className="flex flex-wrap justify-end gap-2">
                  {incident.status === 'open' && (
                    <Button icon={<PlayCircle size={14} />} disabled={!canMutate || !actions.includes('acknowledge')} title={canMutate ? undefined : reason} onClick={() => acknowledge([incident])}>
                      Acknowledge
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    icon={<CheckCircle size={14} weight="bold" />}
                    loading={resolving}
                    disabled={!actions.includes('resolve')}
                    title={canMutate ? undefined : reason}
                    onClick={() => void submitResolve()}
                  >
                    Resolve
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card as="section" aria-label="Originating run">
            <CardHeader title="Originating run" />
            <div className="mt-2">
              <OriginRun detail={detail} />
            </div>
          </Card>

          {detail.related_open.length > 0 && (
            <Card as="section" aria-label="Related open incidents">
              <CardHeader title={`Related open incidents${incident.service_name ? ` for ${incident.service_name}` : ''}`} />
              <div className="mt-2">
                <RelatedIncidents detail={detail} hrefFor={(id) => `/incidents/${id}`} />
              </div>
            </Card>
          )}
        </aside>
      </div>
    </div>
  )
}
