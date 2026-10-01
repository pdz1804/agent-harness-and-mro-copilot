import { Play, Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, errorText } from '../../lib/api'
import type { EvalAgreement, EvalOverview } from '../../lib/api-types'
import { Button, Card, CardGridSkeleton, CardHeader, EmptyState, ErrorState, Row, Skeleton, Table } from '../ui'
import { HERO_METRICS, MetricCard, MetricTable } from './MetricCard'
import { MetricTrendChart } from './MetricTrendChart'

/** Judge vs human agreement: how often the LLM judge and the people rating
 * runs with thumbs agree. */
function AgreementCard() {
  const [agreement, setAgreement] = useState<EvalAgreement | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    api.getEvalAgreement().then(
      (data) => {
        if (cancelled) return
        setError(null)
        setAgreement(data)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load judge agreement.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(), [load])

  return (
    <Card as="section" aria-labelledby="agreement-heading">
      <CardHeader title={<span id="agreement-heading">Judge vs human agreement</span>} />
      {error ? (
        <div className="mt-2">
          <ErrorState
            message={error}
            onRetry={() => {
              setError(null)
              load()
            }}
          />
        </div>
      ) : agreement === null ? (
        <Skeleton className="mt-3 h-20 w-full" />
      ) : agreement.compared === 0 ? (
        <p className="mt-2 text-sm text-zinc-700">
          Give runs a thumbs-up or down on an eval run, then run a scoring job; agreement appears once a run has both.
          {agreement.human_votes > 0 && <span className="font-data tabular-nums"> {agreement.human_votes} human votes so far.</span>}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-start gap-x-10 gap-y-4">
          <div>
            <p className="font-[family-name:var(--font-display)] text-[1.75rem] leading-none font-semibold text-zinc-950 tabular-nums">
              {agreement.agreement_rate === null ? 'n/a' : `${Math.round(agreement.agreement_rate * 100)}%`}
            </p>
            <p className="mt-1.5 text-xs text-zinc-600">
              <span className="tabular-nums">{agreement.compared}</span> runs compared of <span className="tabular-nums">{agreement.human_votes}</span> with a human vote
            </p>
          </div>
          <dl className="grid min-w-[16rem] grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[13px]">
            {[
              ['Both thumbs-up (judge passed)', agreement.both_up],
              ['Both thumbs-down (judge failed)', agreement.both_down],
              ['Judge passed, human thumbs-down', agreement.judge_up_human_down],
              ['Judge failed, human thumbs-up', agreement.judge_down_human_up],
            ].map(([label, count]) => (
              <div key={label} className="contents">
                <dt className="text-zinc-600">{label}</dt>
                <dd className="font-data text-right font-semibold text-zinc-900 tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  )
}

function OverviewBody({ overview, onGoToRuns }: { overview: EvalOverview; onGoToRuns: () => void }) {
  if (overview.metrics.length === 0) {
    return (
      <EmptyState
        icon={<Play size={22} weight="duotone" />}
        title="No scored runs yet"
        description="Run the eval agent over your own chat runs to see scores, trends and the worst runs here."
        action={
          <Button variant="secondary" onClick={onGoToRuns}>
            Go to scoring runs
          </Button>
        }
        example="Use “Score my sessions” at the top of this page."
      />
    )
  }
  const heroes = overview.metrics.filter((row) => HERO_METRICS.includes(row.metric)).sort((a, b) => HERO_METRICS.indexOf(a.metric) - HERO_METRICS.indexOf(b.metric))
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {heroes.map((row) => (
          <MetricCard key={row.metric} row={row} />
        ))}
      </div>
      <MetricTable rows={overview.metrics.filter((row) => !HERO_METRICS.includes(row.metric))} />

      <Card>
        <CardHeader title={`Trend (last ${overview.days} days)`} />
        <div className="mt-3">
          <MetricTrendChart series={overview.series} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Worst runs (task success)" />
          {overview.worst_runs.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No task_success scores recorded yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--color-line)]">
              {overview.worst_runs.map((r) => (
                <li key={r.run_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/runs/${r.run_id}`} className="ui-btn-link font-data text-xs">
                      {r.run_id}
                    </Link>
                    {r.rationale && <p className="mt-0.5 truncate text-xs text-zinc-500">{r.rationale}</p>}
                  </div>
                  <span className="font-data shrink-0 text-xs font-semibold text-rose-700 tabular-nums">{Math.round(r.score * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padding="none" className="overflow-hidden">
          <CardHeader title="Per-agent breakdown" className="px-4 pt-4 pb-2" />
          {overview.by_agent.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-zinc-500">No per-agent data yet.</p>
          ) : (
            <Table label="Per-agent breakdown" className="!rounded-none !border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Metric</th>
                  <th className="text-right">Mean</th>
                  <th className="text-right">n</th>
                </tr>
              </thead>
              <tbody>
                {overview.by_agent.map((r, i) => (
                  <Row key={i}>
                    <td className="font-data text-xs text-zinc-700">{r.agent_id ?? 'unassigned'}</td>
                    <td className="text-xs text-zinc-600">{r.metric}</td>
                    <td className="font-data text-right text-xs font-semibold text-zinc-800 tabular-nums">{r.mean.toFixed(2)}</td>
                    <td className="text-right text-xs text-zinc-500 tabular-nums">{r.n}</td>
                  </Row>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

/** Overview: agreement card, metric KPI cards, trend chart, worst runs. */
export function OverviewTab({ onGoToRuns }: { onGoToRuns: () => void }) {
  const [overview, setOverview] = useState<EvalOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.getEvalMetricsOverview({ days: 30 }).then(
      (data) => {
        if (cancelled) return
        setError(null)
        setOverview(data)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load the eval overview.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  let body
  if (error) body = <ErrorState message={error} onRetry={() => setRefreshToken((n) => n + 1)} />
  else if (overview === null) body = <CardGridSkeleton count={4} className="grid grid-cols-2 gap-3 lg:grid-cols-4" />
  else
    body = (
      <>
        {!overview.judge_available && (
          <div role="status" className="flex items-start gap-3 rounded-[14px] bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
            <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
            <div>
              <p className="font-medium">Judge unavailable: no OPENAI_API_KEY configured.</p>
              <p className="mt-1 text-xs text-amber-800">
                Deterministic trace metrics (latency, tokens, steps, tool errors, rule-based tool-use and safety scores) can still be scored and shown below; LLM-judged metrics
                (task_success, groundedness, tool_choice, routing_fit) show as “unavailable” rather than a guessed number.
              </p>
            </div>
          </div>
        )}
        {(overview.judge_available || overview.metrics.length > 0) && <OverviewBody overview={overview} onGoToRuns={onGoToRuns} />}
      </>
    )

  return (
    <div className="space-y-5">
      <AgreementCard />
      {body}
    </div>
  )
}
