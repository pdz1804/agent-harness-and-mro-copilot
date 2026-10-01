import { ArrowSquareOut, Check, CheckCircle, Copy, PlayCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { ApiError, api, errorText } from '../../lib/api'
import type { Incident, IncidentDetail } from '../../lib/api-types'
import { durationBetween, nextActions, resolutionNoteError } from '../../lib/incident-lifecycle'
import { Button, Card, CopyId, ErrorState, FactList, LinkButton, RelativeTime, RowActions, Sheet, SheetSection, SheetSkeleton, type RowAction } from '../ui'
import { IncidentStatusBadge, SeverityBadge } from './IncidentBadges'
import { IncidentTimeline, OriginRun, RelatedIncidents, ResolveNoteField } from './IncidentParts'

interface IncidentSheetProps {
  incidentId: string
  /** The row as listed, with any optimistic overlay (instant header). */
  listed: Incident | null
  /** Overlay for the fetched detail (optimistic acknowledge). */
  merge: <T extends Incident>(incident: T) => T
  canMutate: boolean
  reason: string
  /** Bumped when the list reloads, so the timeline refetches. */
  refreshToken: number
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onOpenOther: (id: string) => void
  onAcknowledge: (incident: Incident) => void
  onResolve: (incident: Incident, note: string) => Promise<boolean>
}

/** Quick-inspect sheet for one incident: facts, timeline, related incidents
 * and the two lifecycle actions. Deep link: `/incidents?open=<id>`. Closing
 * (or stepping away) with an unsent resolution note asks before discarding. */
export function IncidentSheet({ incidentId, listed, merge, canMutate, reason, refreshToken, onClose, onPrev, onNext, onOpenOther, onAcknowledge, onResolve }: IncidentSheetProps) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null)
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api.getIncident(incidentId).then(
      (d) => {
        if (!cancelled) setDetail(d)
      },
      (err: unknown) => {
        if (!cancelled) setError({ message: errorText(err, 'Could not load this incident.'), missing: err instanceof ApiError && err.status === 404 })
      },
    )
    return () => {
      cancelled = true
    }
  }, [incidentId, refreshToken])

  const current = detail?.id === incidentId ? detail : null
  const base: Incident | null = current ?? listed
  const incident = base ? merge(base) : null
  useDocumentTitle(incident?.title ?? null)

  const timeToAck = incident?.acknowledged_at ? durationBetween(incident.created_at, incident.acknowledged_at) : ''
  const timeToResolve = incident?.resolved_at ? durationBetween(incident.created_at, incident.resolved_at) : ''
  const dirty = note.trim().length > 0
  const noteError = touched ? resolutionNoteError(note) : null
  const guard = (go: () => void) => (dirty ? setPendingNav(() => go) : go())

  const actions = incident ? nextActions(incident.status, canMutate) : []
  const open = incident?.status === 'open'
  const terminal = incident ? nextActions(incident.status, true).length === 0 : false

  const submitResolve = async () => {
    if (!incident) return
    setTouched(true)
    if (resolutionNoteError(note)) return
    setResolving(true)
    const ok = await onResolve(incident, note)
    setResolving(false)
    if (ok) {
      setNote('')
      setTouched(false)
    }
  }

  const copyId = () => {
    if (!incident) return
    void navigator.clipboard?.writeText(incident.id).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }, () => undefined)
  }

  const menu: RowAction[] = incident
    ? [
        {
          label: 'Acknowledge',
          icon: <PlayCircle size={14} />,
          disabled: !open || !canMutate,
          disabledReason: !canMutate ? reason : !open ? 'Only open incidents can be acknowledged.' : undefined,
          onSelect: () => onAcknowledge(incident),
        },
        { label: copied ? 'Copied' : 'Copy ID', icon: copied ? <Check size={14} /> : <Copy size={14} />, onSelect: copyId },
        { label: 'Open full page', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/incidents/${incident.id}`) },
        ...(incident.run_id ? [{ label: 'View originating run', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/runs/${incident.run_id}`) }] : []),
      ]
    : []

  return (
    <Sheet
      open
      onClose={() => guard(onClose)}
      onPrev={onPrev && (() => guard(onPrev))}
      onNext={onNext && (() => guard(onNext))}
      eyebrow="Incidents"
      label={incident?.title ?? 'Incident'}
      title={incident?.title ?? 'Incident'}
      width="lg"
      status={
        incident ? (
          <>
            <SeverityBadge severity={incident.severity} />
            <IncidentStatusBadge status={incident.status} />
          </>
        ) : undefined
      }
      meta={
        incident && (
          <>
            <CopyId value={incident.id} label="incident ID" />
            {incident.service_name && (
              <>
                <span aria-hidden="true">·</span>
                <span>{incident.service_name}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              Opened <RelativeTime value={incident.created_at} />
            </span>
          </>
        )
      }
      headerActions={incident && <RowActions visibility="always" label={`More actions for ${incident.id}`} items={menu} />}
      footer={
        incident && (
          <>
            <LinkButton to={`/incidents/${incident.id}`} variant="ghost" icon={<ArrowSquareOut size={14} />} className="mr-auto">
              Open full page
            </LinkButton>
            {open && (
              <Button icon={<PlayCircle size={14} />} disabled={!canMutate} title={canMutate ? undefined : reason} onClick={() => onAcknowledge(incident)}>
                Acknowledge
              </Button>
            )}
            {!terminal && (
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
            )}
          </>
        )
      }
    >
      {pendingNav && (
        <Card padding="sm" className="mb-4 !bg-amber-50/70">
          <p className="text-[13px] font-medium text-zinc-900">Discard changes?</p>
          <p className="mt-0.5 text-xs text-zinc-600">Your resolution note has not been saved.</p>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPendingNav(null)}>
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="danger-solid"
              onClick={() => {
                const go = pendingNav
                setPendingNav(null)
                setNote('')
                go()
              }}
            >
              Discard
            </Button>
          </div>
        </Card>
      )}
      {error?.missing && !incident ? (
        <ErrorState message="Incident not found. It may not exist, or it belongs to another user's run." />
      ) : error && !incident ? (
        <ErrorState message={error.message} />
      ) : !incident ? (
        <SheetSkeleton />
      ) : (
        <>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Service', value: incident.service_name ?? 'None' },
                { label: 'Opened', value: <RelativeTime value={incident.created_at} /> },
                { label: 'Acknowledged', value: <RelativeTime value={incident.acknowledged_at} fallback="Not yet" /> },
                { label: 'Resolved', value: <RelativeTime value={incident.resolved_at} fallback="Not yet" /> },
                ...(timeToAck ? [{ label: 'Time to acknowledge', value: timeToAck }] : []),
                ...(timeToResolve ? [{ label: 'Time to resolve', value: timeToResolve }] : []),
              ]}
            />
            <p className="pt-1 text-[13px] whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere]">{incident.description || 'No description was provided.'}</p>
          </SheetSection>

          <SheetSection title="Activity">
            {current ? <IncidentTimeline entries={current.timeline} /> : error ? <ErrorState message={error.message} /> : <SheetSkeleton />}
          </SheetSection>

          {terminal ? (
            <SheetSection title="Resolution">
              <p className="text-[13px] whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere]">{incident.resolution_note || 'Resolved without a note.'}</p>
            </SheetSection>
          ) : (
            <SheetSection title="Resolve">
              {!canMutate && <p className="text-[13px] text-zinc-600">{reason}</p>}
              <ResolveNoteField value={note} onChange={setNote} onBlur={() => setTouched(true)} error={noteError} disabled={!canMutate || resolving} title={canMutate ? undefined : reason} />
            </SheetSection>
          )}

          <SheetSection title="Originating run">{current ? <OriginRun detail={current} /> : <SheetSkeleton />}</SheetSection>

          {current && (
            <SheetSection title="Related open incidents">
              <RelatedIncidents detail={current} hrefFor={(id) => `/incidents?open=${id}`} onPick={(id) => guard(() => onOpenOther(id))} />
            </SheetSection>
          )}
        </>
      )}
    </Sheet>
  )
}
