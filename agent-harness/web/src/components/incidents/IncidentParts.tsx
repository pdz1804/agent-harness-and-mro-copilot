import { Link } from 'react-router-dom'
import type { IncidentDetail, IncidentTimelineEntry } from '../../lib/api-types'
import { NOTE_MAX, durationBetween, timelineEventLabel } from '../../lib/incident-lifecycle'
import { Chip, CopyId, Field, RelativeTime, StatusBadge, Textarea } from '../ui'
import { IncidentStatusBadge, SeverityBadge } from './IncidentBadges'

/** Vertical timeline of lifecycle events (opened, acknowledged, resolved, reopened). */
export function IncidentTimeline({ entries }: { entries: IncidentTimelineEntry[] }) {
  if (entries.length === 0) return <p className="text-[13px] text-zinc-500">No activity recorded yet.</p>
  return (
    <ol>
      {entries.map((entry, index) => (
        <li key={`${entry.event}-${entry.at}`} className="relative flex gap-3 pb-4 last:pb-0">
          {index < entries.length - 1 && <span className="absolute top-3 bottom-0 left-[5px] w-px bg-zinc-200" aria-hidden="true" />}
          <span className="relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-sky-600 bg-white" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] text-zinc-900">
              <span>
                <span className="font-medium">{timelineEventLabel(entry.event)}</span>
                {entry.actor_name && <span className="text-zinc-600"> by {entry.actor_name}</span>}
              </span>
              <RelativeTime value={entry.at} className="text-xs text-zinc-500" />
            </p>
            {entry.note && (
              <p className="mt-1 rounded-[10px] bg-zinc-950/[0.04] px-2.5 py-1.5 text-[13px] whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere]">{entry.note}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** The run that raised the incident, with the way back to it. */
export function OriginRun({ detail }: { detail: IncidentDetail }) {
  if (!detail.run) {
    return (
      <p className="text-[13px] text-zinc-500">
        {detail.run_id ? 'The run that raised this incident no longer exists.' : 'This incident was not raised by a run.'}
      </p>
    )
  }
  const run = detail.run
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-zinc-900 [overflow-wrap:anywhere]">{run.objective}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <StatusBadge status={run.status} />
        <Link to={`/runs/${run.run_id}`} className="ui-btn-link font-data">
          {run.run_id}
        </Link>
        {run.session_id && (
          <span className="inline-flex items-center gap-1">
            Session <CopyId value={run.session_id} label="session ID" />
          </span>
        )}
      </div>
    </div>
  )
}

/** Other open incidents on the same service: `onPick` opens one in place (sheet), otherwise each links to `hrefFor`. */
export function RelatedIncidents({ detail, hrefFor, onPick }: { detail: IncidentDetail; hrefFor: (id: string) => string; onPick?: (id: string) => void }) {
  if (detail.related_open.length === 0) return <p className="text-[13px] text-zinc-500">No other open incidents on this service.</p>
  return (
    <ul className="space-y-2">
      {detail.related_open.map((related) => (
        <li key={related.id} className="min-w-0">
          {onPick ? (
            <button type="button" onClick={() => onPick(related.id)} className="ui-btn-link block max-w-full truncate text-left text-[13px]" title={related.title}>
              {related.title}
            </button>
          ) : (
            <Link to={hrefFor(related.id)} className="ui-btn-link block truncate text-[13px]" title={related.title}>
              {related.title}
            </Link>
          )}
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-data">{related.id}</span>
            <SeverityBadge severity={related.severity} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Status, severity and time-to-ack / time-to-resolve chips. */
export function IncidentStatusRow({ detail }: { detail: Pick<IncidentDetail, 'severity' | 'status' | 'created_at' | 'acknowledged_at' | 'resolved_at'> }) {
  const toAck = detail.acknowledged_at ? durationBetween(detail.created_at, detail.acknowledged_at) : ''
  const toResolve = detail.resolved_at ? durationBetween(detail.created_at, detail.resolved_at) : ''
  return (
    <>
      <SeverityBadge severity={detail.severity} />
      <IncidentStatusBadge status={detail.status} />
      {toAck && <Chip tone="muted" title="Time from opened to acknowledged">Ack in {toAck}</Chip>}
      {toResolve && <Chip tone="muted" title="Time from opened to resolved">Resolved in {toResolve}</Chip>}
    </>
  )
}

interface ResolveNoteFieldProps {
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  error: string | null
  disabled?: boolean
  title?: string
}

/** The resolution note: optional, capped at the API limit, validated on blur. */
export function ResolveNoteField({ value, onChange, onBlur, error, disabled, title }: ResolveNoteFieldProps) {
  return (
    <Field label="Resolution note" optional error={error} hint={`What fixed it, for the record. ${value.trim().length}/${NOTE_MAX}`}>
      {(field) => (
        <Textarea
          {...field}
          rows={3}
          value={value}
          disabled={disabled}
          title={title}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder="Rolled back the 14:02 deploy; latency recovered."
          className="w-full"
        />
      )}
    </Field>
  )
}
