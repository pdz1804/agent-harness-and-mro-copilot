import { ArrowClockwise, ArrowSquareOut, CheckCircle, Play, Warning, XCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { EmptyState } from '../components/EmptyState'
import { Skeleton } from '../components/Skeleton'
import { HERO_METRICS, MetricCard, MetricTable } from '../components/evals/MetricCard'
import { MetricTrendChart } from '../components/evals/MetricTrendChart'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import { progressPercent } from '../lib/eval-shapes'
import type { EvalAgreement, EvalOverview, EvalRun, EvalRunSummary } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

function formatTimestamp(value: string | null): string {
  if (!value) return 'unknown time'
  return new Date(value).toLocaleString()
}

type Tab = 'overview' | 'runs' | 'offline'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'runs', label: 'Scoring runs' },
  { key: 'offline', label: 'Offline suite' },
]

/** Evals tab (phase 07): an in-app LLM-as-judge eval agent that scores real
 * chat runs on task_success/groundedness/tool_use_correctness/safety/
 * routing_fit + deterministic trace metrics, plus a metrics overview with
 * trends over time — and, unchanged from before this phase, the offline
 * recorded-transcript regression suite's MLflow results in its own
 * section. */
export function EvalsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = (searchParams.get('tab') as Tab) ?? 'overview'

  function setTab(next: Tab) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.set('tab', next)
      return params
    })
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Evals"
        description={<>Score real session chats with an LLM-as-judge eval agent, track metrics over time, and (still
            available below) the offline recorded-transcript regression suite.</>}
      />

      <div className="mt-4 flex gap-1 border-b border-zinc-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium transition ${
              tab === t.key
                ? 'border-b-2 border-sky-600 text-sky-700'
                : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === 'overview' && (
          <div className="space-y-4">
            <AgreementCard />
            <OverviewTab />
          </div>
        )}
        {tab === 'runs' && <RunsTab />}
        {tab === 'offline' && <OfflineSuiteTab />}
      </div>
    </div>
  )
}

// --- Judge vs human agreement ------------------------------------------

function AgreementCard() {
  const [agreement, setAgreement] = useState<EvalAgreement | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    api
      .getEvalAgreement()
      .then((data) => {
        if (cancelled) return
        setError(null)
        setAgreement(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load judge agreement.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(), [load])

  return (
    <section className="ui-card p-4" aria-labelledby="agreement-heading">
      <h2 id="agreement-heading" className="text-sm font-semibold text-zinc-800">
        Judge vs human agreement
      </h2>
      {error ? (
        <div className="mt-2">
          <ErrorBanner
            message={error}
            onRetry={() => {
              setError(null)
              load()
            }}
          />
        </div>
      ) : agreement === null ? (
        <Skeleton className="mt-2 h-20 w-full" />
      ) : agreement.compared === 0 ? (
        <p className="mt-2 text-sm text-zinc-700">
          Give runs a thumbs-up or down on a run page, then run a scoring job; agreement appears once a run has both.
          {agreement.human_votes > 0 && (
            <span className="font-data tabular-nums"> {agreement.human_votes} human votes so far.</span>
          )}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-start gap-x-8 gap-y-3">
          <div>
            <p className="font-data text-3xl font-semibold tabular-nums text-zinc-900">
              {agreement.agreement_rate === null ? 'n/a' : `${Math.round(agreement.agreement_rate * 100)}%`}
            </p>
            <p className="text-xs text-zinc-600">
              <span className="font-data tabular-nums">{agreement.compared}</span> runs compared of{' '}
              <span className="font-data tabular-nums">{agreement.human_votes}</span> with a human vote
            </p>
          </div>
          <table className="min-w-[260px] text-left text-sm">
            <caption className="sr-only">Judge versus human verdict breakdown</caption>
            <thead>
              <tr className="text-xs text-zinc-600">
                <th scope="col" className="py-1 pr-6 font-medium">
                  Judge / human
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Runs
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Both thumbs-up (judge passed)', agreement.both_up],
                ['Both thumbs-down (judge failed)', agreement.both_down],
                ['Judge passed, human thumbs-down', agreement.judge_up_human_down],
                ['Judge failed, human thumbs-up', agreement.judge_down_human_up],
              ].map(([label, count]) => (
                <tr key={label} className="border-t border-zinc-100">
                  <td className="py-1 pr-6 text-xs text-zinc-700">{label}</td>
                  <td className="py-1 text-right font-data text-xs font-semibold tabular-nums text-zinc-900">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// --- Overview ----------------------------------------------------------

function OverviewTab() {
  const [overview, setOverview] = useState<EvalOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const load = useCallback(() => {
    setError(null)
    api
      .getEvalMetricsOverview({ days: 30 })
      .then(setOverview)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load the eval overview.'))
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshToken])

  if (error) return <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />
  if (overview === null) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (!overview.judge_available) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">Judge unavailable — no OPENAI_API_KEY configured.</p>
            <p className="mt-1 text-xs text-amber-800">
              Deterministic trace metrics (latency, tokens, steps, tool errors, rule-based tool-use/safety
              scores) can still be scored and shown below; LLM-judged metrics (task_success, groundedness,
              tool_choice, routing_fit) will show as "unavailable" rather than a guessed number.
            </p>
          </div>
        </div>
        {overview.metrics.length > 0 && <OverviewBody overview={overview} />}
      </div>
    )
  }

  return <OverviewBody overview={overview} />
}

function OverviewBody({ overview }: { overview: EvalOverview }) {
  if (overview.metrics.length === 0) {
    return (
      <EmptyState
        icon={<Play size={28} weight="duotone" />}
        title="No scored runs yet"
        description="Head to the Scoring runs tab and click “Score my sessions” to run the eval agent over your own chat runs."
      />
    )
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {overview.metrics
          .filter((row) => HERO_METRICS.includes(row.metric))
          .sort((a, b) => HERO_METRICS.indexOf(a.metric) - HERO_METRICS.indexOf(b.metric))
          .map((row) => (
            <MetricCard key={row.metric} row={row} />
          ))}
      </div>
      <MetricTable rows={overview.metrics.filter((row) => !HERO_METRICS.includes(row.metric))} />

      <div className="ui-card p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-800">Trend (last {overview.days} days)</h2>
        <MetricTrendChart series={overview.series} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="ui-card p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-800">Worst runs (task success)</h2>
          {overview.worst_runs.length === 0 ? (
            <p className="text-sm text-zinc-500">No task_success scores recorded yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {overview.worst_runs.map((r) => (
                <li key={r.run_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/runs/${r.run_id}`} className="truncate font-data text-xs text-sky-700 hover:underline">
                      {r.run_id}
                    </Link>
                    {r.rationale && <p className="mt-0.5 truncate text-xs text-zinc-500">{r.rationale}</p>}
                  </div>
                  <span className="shrink-0 font-data text-xs font-semibold text-rose-700">
                    {Math.round(r.score * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ui-card overflow-x-auto p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-800">Per-agent breakdown</h2>
          {overview.by_agent.length === 0 ? (
            <p className="text-sm text-zinc-500">No per-agent data yet.</p>
          ) : (
            <table className="w-full min-w-[320px] text-left text-sm">
              <thead>
                <tr className="text-xs text-zinc-500">
                  <th className="py-1.5 pr-3">Agent</th>
                  <th className="py-1.5 pr-3">Metric</th>
                  <th className="py-1.5 pr-3">Mean</th>
                  <th className="py-1.5">n</th>
                </tr>
              </thead>
              <tbody>
                {overview.by_agent.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-100">
                    <td className="py-1.5 pr-3 font-data text-xs text-zinc-700">{r.agent_id ?? 'unassigned'}</td>
                    <td className="py-1.5 pr-3 text-xs text-zinc-600">{r.metric}</td>
                    <td className="py-1.5 pr-3 font-data text-xs font-semibold text-zinc-800">
                      {r.mean.toFixed(2)}
                    </td>
                    <td className="py-1.5 text-xs text-zinc-500">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Scoring runs --------------------------------------------------------

function RunsTab() {
  const [runs, setRuns] = useState<EvalRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const { me } = useMe()
  const canRunEvals = me ? me.permissions.includes('run_evals') : true

  const load = useCallback(() => {
    setError(null)
    api
      .listEvalRuns()
      .then(setRuns)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load scoring runs.'))
  }, [])

  useEffect(() => {
    load()
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [load])

  const hasInFlight = runs?.some((r) => r.status === 'queued' || r.status === 'running') ?? false
  useEffect(() => {
    if (!hasInFlight) return
    const id = window.setInterval(load, 1200)
    pollRef.current = id
    return () => window.clearInterval(id)
  }, [hasInFlight, load])

  async function startScoring() {
    setStarting(true)
    setStartError(null)
    try {
      await api.startEvalRun({ scope: 'mine', limit: 200 })
      load()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setStartError('Your role cannot start a scoring run (viewers may only read results).')
      } else {
        setStartError(err instanceof ApiError ? err.message : 'Failed to start a scoring run.')
      }
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-500">
          Runs the eval agent over your own session chats and persists a score per metric per run.
        </p>
        <button
          type="button"
          onClick={startScoring}
          disabled={!canRunEvals || starting}
          title={canRunEvals ? undefined : disabledReason(me, 'run_evals')}
          className="ui-btn ui-btn-primary ui-btn-sm shrink-0"
        >
          <Play size={14} weight="fill" />
          {starting ? 'Starting…' : 'Score my sessions'}
        </button>
      </div>

      {startError && <ErrorBanner message={startError} />}
      {error && <ErrorBanner message={error} onRetry={load} />}

      {!error && runs === null ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : runs && runs.length > 0 ? (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                to={`/evals/runs/${run.id}`}
                className="ui-card ui-card-hover flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <p className="font-data text-xs text-zinc-500">{run.id}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    scope={run.scope} · judge={run.judge_model} · {formatTimestamp(run.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-[width]"
                      style={{ width: `${progressPercent(run.done, run.total)}%` }}
                    />
                  </div>
                  <span className="font-data text-xs text-zinc-500">
                    {run.done}/{run.total}
                  </span>
                  <StatusPill status={run.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !error && (
          <EmptyState
            icon={<Play size={28} weight="duotone" />}
            title="No scoring runs yet"
            description="Click “Score my sessions” to run the eval agent over your own chat sessions."
          />
        )
      )}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-rose-100 text-rose-800',
    running: 'bg-sky-100 text-sky-800',
    queued: 'bg-zinc-100 text-zinc-700',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-zinc-100 text-zinc-700'}`}>
      {status}
    </span>
  )
}

// --- Offline suite (unchanged behavior, relabelled) ---------------------

function OfflineSuiteTab() {
  const [evals, setEvals] = useState<EvalRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .listEvals()
      .then((data) => {
        if (cancelled) return
        setEvals(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load eval results.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-zinc-500">
          Real MLflow results from the recorded-transcript regression suite (
          <code className="font-data">python -m agent_harness.eval.run_eval</code>).
        </p>
        <button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          className="ui-btn ui-btn-secondary ui-btn-sm shrink-0"
        >
          <ArrowClockwise size={14} weight="bold" />
          Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />}

      {!error && evals === null ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : evals && evals.length > 0 ? (
        evals.map((run) => (
          <div key={run.run_id} className="ui-card ui-card-hover p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900">{run.run_name}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  <span className="font-data">{run.run_id}</span> · {run.status} · {formatTimestamp(run.start_time)}
                </p>
              </div>
              {run.mlflow_url && (
                <a
                  href={run.mlflow_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ui-btn ui-btn-secondary ui-btn-sm shrink-0"
                >
                  <ArrowSquareOut size={13} weight="bold" />
                  Open in MLflow
                </a>
              )}
            </div>

            {run.scorers.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {run.scorers.map((scorer) => {
                  const passed = scorer.mean_score >= 1
                  const pct = Math.max(0, Math.min(100, scorer.mean_score * 100))
                  return (
                    <li key={scorer.name} className="text-sm">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          {passed ? (
                            <CheckCircle size={15} weight="fill" className="shrink-0 text-emerald-600" />
                          ) : (
                            <XCircle size={15} weight="fill" className="shrink-0 text-rose-600" />
                          )}
                          <span className="truncate font-data text-zinc-800">{scorer.name}</span>
                        </div>
                        <span className={`shrink-0 font-data text-xs font-semibold ${passed ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {pct.toFixed(0)}% pass
                        </span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-zinc-100"
                        role="progressbar"
                        aria-label={`${scorer.name} pass rate`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(pct)}
                      >
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ${passed ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">No scorer metrics recorded for this run.</p>
            )}
          </div>
        ))
      ) : (
        !error && (
          <p className="text-sm text-zinc-500">
            No eval runs found yet. Run <code className="font-data">python -m agent_harness.eval.run_eval</code>{' '}
            against a reachable MLflow server, then refresh.
          </p>
        )
      )}
    </div>
  )
}
