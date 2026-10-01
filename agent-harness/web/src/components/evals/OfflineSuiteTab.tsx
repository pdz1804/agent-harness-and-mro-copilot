import { ArrowClockwise, ArrowSquareOut, CheckCircle, Flask, XCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { EvalRun } from '../../lib/api-types'
import { AnchorButton, Button, Card, CardHeader, Chip, CopyId, EmptyState, ErrorState, ListSkeleton, RelativeTime } from '../ui'

/** The offline recorded-transcript regression suite: real MLflow results. */
export function OfflineSuiteTab() {
  const [evals, setEvals] = useState<EvalRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRefreshing(true)
    api
      .listEvals()
      .then((data) => {
        if (cancelled) return
        setError(null)
        setEvals(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load eval results.'))
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const reload = () => setRefreshToken((n) => n + 1)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-500">
          Real MLflow results from the recorded-transcript regression suite (<code className="font-data">python -m agent_harness.eval.run_eval</code>).
        </p>
        <Button size="sm" icon={<ArrowClockwise size={14} weight="bold" />} onClick={reload} loading={refreshing}>
          Refresh
        </Button>
      </div>

      {error && evals === null ? (
        <ErrorState message={error} onRetry={reload} />
      ) : evals === null ? (
        <ListSkeleton rows={2} />
      ) : evals.length === 0 ? (
        <EmptyState
          icon={<Flask size={22} weight="duotone" />}
          title="No offline eval runs yet"
          description="Run the regression suite against a reachable MLflow server, then refresh."
          example={<code className="font-data">python -m agent_harness.eval.run_eval</code>}
        />
      ) : (
        evals.map((run) => (
          <Card key={run.run_id}>
            <CardHeader
              title={run.run_name}
              meta={
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <CopyId value={run.run_id} label="MLflow run ID" />
                  <Chip tone={run.status.toUpperCase() === 'FINISHED' ? 'ok' : 'neutral'} dot>
                    {run.status}
                  </Chip>
                  <RelativeTime value={run.start_time} fallback="unknown time" />
                </span>
              }
              actions={
                run.mlflow_url ? (
                  <AnchorButton href={run.mlflow_url} target="_blank" rel="noreferrer" size="sm" icon={<ArrowSquareOut size={13} weight="bold" />}>
                    Open in MLflow
                  </AnchorButton>
                ) : undefined
              }
            />

            {run.scorers.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {run.scorers.map((scorer) => {
                  const passed = scorer.mean_score >= 1
                  const pct = Math.max(0, Math.min(100, scorer.mean_score * 100))
                  return (
                    <li key={scorer.name} className="text-sm">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          {passed ? <CheckCircle size={15} weight="fill" className="shrink-0 text-emerald-600" /> : <XCircle size={15} weight="fill" className="shrink-0 text-rose-600" />}
                          <span className="font-data truncate text-zinc-800">{scorer.name}</span>
                        </div>
                        <span className={`font-data shrink-0 text-xs font-semibold tabular-nums ${passed ? 'text-emerald-700' : 'text-rose-700'}`}>{pct.toFixed(0)}% pass</span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-zinc-950/[0.07]"
                        role="progressbar"
                        aria-label={`${scorer.name} pass rate`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(pct)}
                      >
                        <div className={`h-full rounded-full transition-[width] duration-500 ${passed ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">No scorer metrics recorded for this run.</p>
            )}
          </Card>
        ))
      )}
    </div>
  )
}
