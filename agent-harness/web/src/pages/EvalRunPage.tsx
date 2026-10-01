import { ArrowSquareOut, Copy } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { RunFeedbackControl } from '../components/evals/RunFeedbackControl'
import { RunScoreTable, VerdictChip } from '../components/evals/RunScoreTable'
import {
  AnchorButton,
  Button,
  Card,
  Chip,
  CopyId,
  EmptyState,
  ErrorBanner,
  ErrorState,
  FactList,
  FilteredEmpty,
  LinkButton,
  PageHeader,
  RelativeTime,
  RowActions,
  Segmented,
  Select,
  Sheet,
  SheetSection,
  Skeleton,
  TableSkeleton,
  useToast,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { EvalResultRow, EvalRunDetail } from '../lib/api-types'
import { METRIC_LABELS, METRIC_TOOLTIPS, formatMetricValue, progressPercent } from '../lib/eval-shapes'
import {
  EVAL_RESULT_SORT_COLUMNS,
  UNASSIGNED_AGENT,
  distinctResultValues,
  evalResultSortKey,
  evalStatusTone,
  filterEvalResults,
  hasEvalResultFilters,
  isEvalRunInFlight,
} from '../lib/evals-runs'
import { formatSort, nextSort, parseSort, sortRows } from '../lib/table-sort'
import type { Agent } from '../lib/api-types'

const POLL_MS = 1000
const FILTER_KEYS = ['metric', 'agent', 'show']
const STATUS_LABEL: Record<string, string> = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' }

/** Drill-down for one scoring job: progress, the job's MLflow link, and every
 * scored `(run, metric)` row with its judge rationale. Filters (metric, agent,
 * failed only), sort and the open result live in the URL; a row opens a sheet
 * with the item detail and the feedback control. */
export function EvalRunPage() {
  const { evalRunId = '' } = useParams<{ evalRunId: string }>()
  const toast = useToast()
  const [detail, setDetail] = useState<EvalRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [metric, setMetric] = useUrlState('metric')
  const [agent, setAgent] = useUrlState('agent')
  const [show, setShow] = useUrlEnum('show', ['all', 'failed'] as const, 'all')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const [openId, setOpenId] = useUrlState('open')
  const clearParams = useClearUrlParams()
  useDocumentTitle(detail ? `Scoring run ${evalRunId}` : null)

  const load = useCallback(() => {
    api.getEvalRun(evalRunId).then(
      (data) => {
        setError(null)
        setDetail(data)
      },
      (err: unknown) => setError(errorText(err, 'Failed to load this eval run.')),
    )
  }, [evalRunId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!detail || !isEvalRunInFlight(detail.status)) return
    const id = window.setInterval(load, POLL_MS)
    return () => window.clearInterval(id)
  }, [detail, load])

  useEffect(() => {
    let cancelled = false
    api.listAgents().then(
      (data) => {
        if (!cancelled) setAgents(data)
      },
      () => {
        /* Agent names are a nicety: rows fall back to the raw agent id. */
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const agentLabel = (id: string | null) => (id ? (agentNames.get(id) ?? id) : 'Unassigned')

  const results = useMemo(() => detail?.results ?? [], [detail])
  const metrics = useMemo(() => distinctResultValues(results, (r) => r.metric), [results])
  const agentIds = useMemo(() => distinctResultValues(results, (r) => r.agent_id), [results])
  const hasUnassigned = results.some((r) => r.agent_id === null)
  const filters = { metric, agent, failedOnly: show === 'failed' }
  const active = hasEvalResultFilters(filters)
  const sort = parseSort(sortRaw, EVAL_RESULT_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const rows = useMemo(() => sortRows(filterEvalResults(results, { metric, agent, failedOnly: show === 'failed' }), sort, evalResultSortKey), [results, metric, agent, show, sort])

  const openIndex = rows.findIndex((r) => r.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].id)
  }
  const openRow = results.find((r) => r.id === openId) ?? null

  const progress = detail ? progressPercent(detail.done, detail.total) : 0

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/evals?tab=runs', label: 'Scoring runs' }}
        title={<span className="font-data text-[22px]">{evalRunId}</span>}
        description={detail ? `Judged by ${detail.judge_model} (${detail.judge_version}) over ${detail.scope === 'all' ? 'every user' : 'your own'} sessions.` : 'Loading this scoring run.'}
        meta={
          detail && (
            <>
              <Chip tone={evalStatusTone(detail.status)} dot live={detail.status === 'running'}>
                {STATUS_LABEL[detail.status] ?? detail.status}
              </Chip>
              <span className="tabular-nums">
                {detail.done}/{detail.total} scored
              </span>
              {detail.finished_at && (
                <span>
                  Finished <RelativeTime value={detail.finished_at} />
                </span>
              )}
            </>
          )
        }
        actions={
          detail?.mlflow_url ? (
            <AnchorButton href={detail.mlflow_url} target="_blank" rel="noreferrer" icon={<ArrowSquareOut size={14} weight="bold" />}>
              Open in MLflow
            </AnchorButton>
          ) : undefined
        }
        toolbar={
          detail &&
          results.length > 0 && (
            <>
              <Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} className="max-w-[14rem]">
                <option value="">Any metric</option>
                {metrics.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABELS[m] ?? m}
                  </option>
                ))}
              </Select>
              <Select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)} className="max-w-[12rem]">
                <option value="">Any agent</option>
                {agentIds.map((id) => (
                  <option key={id} value={id}>
                    {agentLabel(id)}
                  </option>
                ))}
                {hasUnassigned && <option value={UNASSIGNED_AGENT}>Unassigned</option>}
              </Select>
              <Segmented
                label="Result filter"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: 'All results' },
                  { value: 'failed', label: 'Failed only' },
                ]}
              />
              {active && (
                <Button variant="ghost" size="sm" onClick={() => clearParams(FILTER_KEYS)}>
                  Clear filters
                </Button>
              )}
              <span className="ml-auto text-xs text-zinc-500 tabular-nums">
                {active ? `${rows.length} of ${results.length}` : `${results.length}`} results
              </span>
            </>
          )
        }
      />

      {error && detail === null ? (
        <ErrorState message={error} onRetry={load} />
      ) : detail === null ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <TableSkeleton rows={6} columns={4} />
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="min-w-[10rem] flex-1">
                <p className="text-xs text-zinc-500">Progress</p>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-950/[0.07]" role="progressbar" aria-label="Scoring progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                  <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${progress}%` }} />
                </div>
              </div>
              {detail.summary && (
                <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
                  <div>
                    <dt className="text-xs text-zinc-500">Scored</dt>
                    <dd className="font-data font-semibold text-zinc-900 tabular-nums">{detail.summary.scored}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-zinc-500">Already scored</dt>
                    <dd className="font-data font-semibold text-zinc-900 tabular-nums">{detail.summary.skipped_already_scored}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-zinc-500">Errors</dt>
                    <dd className={`font-data font-semibold tabular-nums ${detail.summary.errors.length ? 'text-rose-700' : 'text-zinc-900'}`}>{detail.summary.errors.length}</dd>
                  </div>
                </dl>
              )}
            </div>
            {detail.summary && detail.summary.errors.length > 0 && (
              <ul className="font-data mt-3 space-y-1 text-xs text-rose-800 [overflow-wrap:anywhere]">
                {detail.summary.errors.slice(0, 5).map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            )}
          </Card>

          {error && <ErrorBanner message={`Live refresh failed: ${error}`} onRetry={load} />}
          {detail.error && <ErrorBanner message={detail.error} />}

          {results.length === 0 ? (
            isEvalRunInFlight(detail.status) ? (
              <TableSkeleton rows={4} columns={4} />
            ) : (
              <EmptyState
                title="No results"
                icon={<ArrowSquareOut size={22} weight="duotone" />}
                description="Every run in scope may already have been scored under this judge version, so nothing new was added."
              />
            )
          ) : rows.length === 0 ? (
            <FilteredEmpty what="results" onClear={() => clearParams(FILTER_KEYS)} />
          ) : (
            <RunScoreTable results={rows} openId={openId || null} onOpen={setOpenId} sort={sort} onSort={onSort} agentLabel={agentLabel} />
          )}
        </div>
      )}

      {openId && (
        <ResultSheet
          row={openRow}
          loading={detail === null}
          agentLabel={agentLabel}
          onClose={() => setOpenId('')}
          onPrev={rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows.length > 1 ? () => step(1) : undefined}
          onCopied={() => toast({ title: 'Run ID copied' })}
        />
      )}
    </div>
  )
}

interface ResultSheetProps {
  row: EvalResultRow | null
  loading: boolean
  agentLabel: (id: string | null) => string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onCopied: () => void
}

/** One scored `(run, metric)` item: score, judge rationale, and the feedback
 * control for the underlying run. Deep link: `?open=<result id>`. */
function ResultSheet({ row, loading, agentLabel, onClose, onPrev, onNext, onCopied }: ResultSheetProps) {
  const title = row ? (METRIC_LABELS[row.metric] ?? row.metric) : 'Result'
  useDocumentTitle(row ? `${title} · ${row.run_id}` : null)

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Scoring run / Result"
      title={title}
      status={row ? <VerdictChip row={row} /> : undefined}
      meta={
        row && (
          <>
            <CopyId value={row.run_id} label="run ID" />
            <span aria-hidden="true">·</span>
            <RelativeTime value={row.created_at} />
          </>
        )
      }
      headerActions={
        row && (
          <RowActions
            visibility="always"
            label={`More actions for ${title}`}
            items={[
              {
                label: 'Copy run ID',
                icon: <Copy size={14} />,
                onSelect: () => {
                  void navigator.clipboard?.writeText(row.run_id)?.then(onCopied, () => undefined)
                },
              },
            ]}
          />
        )
      }
      footer={
        row && (
          <LinkButton to={`/runs/${row.run_id}`} variant="primary" icon={<ArrowSquareOut size={14} weight="bold" />}>
            Open run
          </LinkButton>
        )
      }
    >
      {!row ? (
        <p className="text-[13px] text-zinc-500">{loading ? 'Loading the result…' : 'This result is not part of the scoring run (it may have been filtered out of the data).'}</p>
      ) : (
        <>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Metric', value: <span title={METRIC_TOOLTIPS[row.metric]}>{title}</span> },
                { label: 'Score', value: <span className="font-data font-semibold tabular-nums">{formatMetricValue(row.metric, row.score)}</span> },
                { label: 'Agent', value: agentLabel(row.agent_id) },
                { label: 'Judge version', value: <span className="font-data text-xs">{row.judge_version}</span> },
                { label: 'Session', value: row.session_id ? <CopyId value={row.session_id} label="session ID" /> : 'None' },
              ]}
            />
          </SheetSection>
          <SheetSection title="Judge rationale">
            {row.rationale ? (
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-800 [overflow-wrap:anywhere]">{row.rationale}</p>
            ) : (
              <p className="text-[13px] text-zinc-500">{row.score === null ? 'No score was produced for this metric.' : 'The judge gave no rationale for this metric.'}</p>
            )}
          </SheetSection>
          <SheetSection title="Your feedback on this run">
            <RunFeedbackControl runId={row.run_id} />
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
