import { ArrowClockwise, Warning } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { ApiError, api } from '../lib/api'
import type { Incident, IncidentSeverity } from '../lib/api-types'

const SEVERITY_STYLES: Record<IncidentSeverity, string> = {
  low: 'bg-zinc-700/50 text-zinc-300 ring-1 ring-inset ring-zinc-600/50',
  medium: 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-500/30',
  critical: 'bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-500/30',
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .listIncidents()
      .then((data) => {
        if (!cancelled) setIncidents(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load incidents.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Incidents</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Real incidents created by approved agent runs, persisted in SQLite.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          <ArrowClockwise size={14} weight="bold" />
          Refresh
        </button>
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />
        ) : incidents === null ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : incidents.length === 0 ? (
          <EmptyState
            icon={<Warning size={32} weight="duotone" />}
            title="No incidents yet"
            description="Incidents created by an approved create_incident tool call will show up here, linked back to the run that created them."
          />
        ) : (
          <ul className="space-y-2">
            {incidents.map((incident) => (
              <li key={incident.id} className="rounded-lg border border-zinc-800 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-data text-xs text-zinc-500">{incident.id}</span>
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[incident.severity]}`}
                    >
                      {incident.severity}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500">{formatTimestamp(incident.created_at)}</span>
                </div>
                <p className="mt-2 text-sm font-medium text-zinc-100">{incident.title}</p>
                <p className="mt-1 text-sm text-zinc-400">{incident.description}</p>
                {incident.run_id && (
                  <Link
                    to={`/runs/${incident.run_id}`}
                    className="mt-2 inline-block text-xs font-medium text-sky-400 hover:text-sky-300"
                  >
                    View originating run →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
