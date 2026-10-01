import { ArrowClockwise, DownloadSimple, ListMagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { StatusBadge } from '../components/StatusBadge'
import { ApiError, api } from '../lib/api'
import type { Incident, RunStatus, RunSummary } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

function formatStartedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

function toDateInputValue(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

async function downloadExport(runId: string) {
  const trace = await api.exportRun(runId)
  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `run-${runId}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** First-class Logs page: every persisted run (survives restarts via
 * PostgreSQL), filterable by status / has-incident / date range, with a
 * per-run trace export (`GET /runs/{id}/export`) — the audit log a real
 * ops team would want, and useful for attaching real evidence to a
 * submission. */
export function LogsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [statusFilter, setStatusFilter] = useState<RunStatus | 'all'>('all')
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'yes' | 'no'>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [exportingId, setExportingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([api.listRuns(), api.listIncidents()])
      .then(([runsData, incidentsData]) => {
        if (cancelled) return
        setRuns(runsData)
        setIncidents(incidentsData)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load logs.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const runIdsWithIncident = useMemo(
    () => new Set((incidents ?? []).filter((i) => i.run_id).map((i) => i.run_id as string)),
    [incidents],
  )

  const filtered = useMemo(() => {
    if (!runs) return null
    return runs.filter((run) => {
      if (statusFilter !== 'all' && run.status !== statusFilter) return false
      const hasIncident = runIdsWithIncident.has(run.run_id)
      if (incidentFilter === 'yes' && !hasIncident) return false
      if (incidentFilter === 'no' && hasIncident) return false
      const day = toDateInputValue(run.started_at)
      if (fromDate && day < fromDate) return false
      if (toDate && day > toDate) return false
      return true
    })
  }, [runs, statusFilter, incidentFilter, fromDate, toDate, runIdsWithIncident])

  const statusOptions: (RunStatus | 'all')[] = [
    'all',
    'running',
    'pending_approval',
    'completed',
    'step_limit_exceeded',
    'time_limit_exceeded',
    'llm_error_exceeded',
    'failed',
  ]

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Logs"
        description={<>Every persisted run trace — audit log + evidence export. Traces survive process
            restarts (PostgreSQL-backed).</>}
        actions={<><button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          className="ui-btn ui-btn-secondary"
        >
          <ArrowClockwise size={14} weight="bold" />
          Refresh
        </button></>}
      />

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Status
          <select name="select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as RunStatus | 'all')}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800"
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All statuses' : s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Incident
          <select name="select"
            value={incidentFilter}
            onChange={(e) => setIncidentFilter(e.target.value as 'all' | 'yes' | 'no')}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800"
          >
            <option value="all">Any</option>
            <option value="yes">Has incident</option>
            <option value="no">No incident</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          From
          <input name="input"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          To
          <input name="input"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800"
          />
        </label>
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />
        ) : filtered === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ListMagnifyingGlass size={32} weight="duotone" />}
            title="No matching runs"
            description="Adjust the filters above, or start a new run."
          />
        ) : (
          <ul className="ui-list ui-card divide-y divide-[var(--color-line)] overflow-hidden">
            {filtered.map((run) => (
              <li key={run.run_id} className="group flex items-center justify-between gap-3 px-4 py-2.5">
                <Link to={`/runs/${run.run_id}`} className="min-w-0 flex-1 hover:opacity-80">
                  <p className="truncate text-[13px] font-medium text-zinc-900">{run.objective}</p>
                  <p className="font-data mt-0.5 truncate text-[11.5px] text-zinc-500">
                    {run.run_id} · {formatStartedAt(run.started_at)}
                    {runIdsWithIncident.has(run.run_id) ? ' · incident opened' : ''}
                  </p>
                </Link>
                <StatusBadge status={run.status} />
                <button
                  type="button"
                  disabled={exportingId === run.run_id}
                  onClick={async () => {
                    setExportingId(run.run_id)
                    try {
                      await downloadExport(run.run_id)
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'Export failed.')
                    } finally {
                      setExportingId(null)
                    }
                  }}
                  title="Export full trace as JSON"
                  aria-label={`Export trace ${run.run_id} as JSON`}
                  className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon shrink-0 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                >
                  <DownloadSimple size={15} weight="bold" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
