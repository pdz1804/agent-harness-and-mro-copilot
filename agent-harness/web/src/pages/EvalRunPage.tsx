import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { RunFeedbackControl } from '../components/evals/RunFeedbackControl'
import { RunScoreTable } from '../components/evals/RunScoreTable'
import { ApiError, api } from '../lib/api'
import type { EvalRunDetail } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

/** Drill-down for one scoring job (`eval_runs` row): progress, the job's
 * own MLflow deep link, and every scored `(run_id, metric)` row with its
 * judge rationale — grouped by run so a reviewer can see one run's full
 * metric set (task_success/groundedness/tool_use/safety/routing_fit +
 * latency/tokens/steps/tool_errors) together. */
export function EvalRunPage() {
  const { evalRunId = '' } = useParams<{ evalRunId: string }>()
  const [detail, setDetail] = useState<EvalRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(() => {
    setError(null)
    api
      .getEvalRun(evalRunId)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load this eval run.'))
  }, [evalRunId])

  useEffect(() => {
    load()
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [load])

  useEffect(() => {
    if (!detail || detail.status === 'completed' || detail.status === 'failed') return
    const id = window.setInterval(load, 1000)
    pollRef.current = id
    return () => window.clearInterval(id)
  }, [detail, load])

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/evals', label: 'Back to scoring runs' }}
        title={evalRunId}
        description={
          detail ? `scope=${detail.scope} · judge_model=${detail.judge_model} · judge_version=${detail.judge_version}` : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && detail === null ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : detail ? (
        <div className="mt-4 space-y-4">
          <div className="ui-card flex flex-wrap items-center gap-4 p-4">
            <div>
              <p className="text-xs text-zinc-500">Status</p>
              <p className="font-data text-sm font-semibold text-zinc-900">{detail.status}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Progress</p>
              <p className="font-data text-sm font-semibold text-zinc-900">
                {detail.done}/{detail.total}
              </p>
            </div>
            {detail.summary && (
              <div>
                <p className="text-xs text-zinc-500">Summary</p>
                <p className="font-data text-xs text-zinc-700">
                  scored={detail.summary.scored} skipped={detail.summary.skipped_already_scored} errors=
                  {detail.summary.errors.length}
                </p>
              </div>
            )}
            {detail.mlflow_url && (
              <a
                href={detail.mlflow_url}
                target="_blank"
                rel="noreferrer"
                className="ui-btn ui-btn-secondary ui-btn-sm ml-auto shrink-0"
              >
                Open in MLflow
              </a>
            )}
          </div>

          {detail.error && <ErrorBanner message={detail.error} />}

          {[...new Set(detail.results.map((r) => r.run_id))].map((runId) => (
            <div key={runId} className="ui-card p-4">
              <Link to={`/runs/${runId}`} className="font-data text-xs text-sky-700 hover:underline">
                {runId}
              </Link>
              <div className="mt-2">
                <RunFeedbackControl runId={runId} compact />
              </div>
              <div className="mt-2">
                <RunScoreTable results={detail.results} runId={runId} />
              </div>
            </div>
          ))}

          {detail.results.length === 0 && detail.status === 'completed' && (
            <p className="text-sm text-zinc-500">No results (every run in scope may already have been scored).</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
