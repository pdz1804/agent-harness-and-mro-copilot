import { ArrowClockwise, ClockCounterClockwise, PlusCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusBadge } from '../components/StatusBadge'
import { Skeleton } from '../components/Skeleton'
import { ApiError, api } from '../lib/api'
import type { RunSummary } from '../lib/api-types'

function formatStartedAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

export function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .listRuns()
      .then((data) => {
        if (!cancelled) setRuns(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load run history.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-100">Run history</h1>
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
        ) : runs === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<ClockCounterClockwise size={32} weight="duotone" />}
            title="No runs yet"
            description="Start an objective to see it appear here with its status and trace."
            action={
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-400 hover:text-sky-300"
              >
                <PlusCircle size={16} weight="bold" />
                Start a run
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-zinc-900 overflow-hidden rounded-lg border border-zinc-800">
            {runs.map((run) => (
              <li key={run.run_id}>
                <Link
                  to={`/runs/${run.run_id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-zinc-900/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-100">{run.objective}</p>
                    <p className="font-data mt-0.5 text-xs text-zinc-600">
                      {run.run_id} · {formatStartedAt(run.started_at)}
                    </p>
                  </div>
                  <StatusBadge status={run.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
