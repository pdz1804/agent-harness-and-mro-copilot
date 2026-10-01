import { Play } from '@phosphor-icons/react'
import { useEffect, useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EvalRunSummary } from '../../lib/api-types'
import { progressPercent } from '../../lib/eval-shapes'
import { EVAL_RUN_SORT_COLUMNS, evalRunSortKey, evalStatusTone, filterEvalRuns, isEvalRunInFlight } from '../../lib/evals-runs'
import { formatSort, nextSort, parseSort, sortRows } from '../../lib/table-sort'
import { Chip, CopyId, EmptyState, ErrorState, FilteredEmpty, RelativeTime, Row, SortHeader, Table, TableSkeleton } from '../ui'

const POLL_MS = 1200

interface EvalRunsTabProps {
  runs: EvalRunSummary[] | null
  error: string | null
  q: string
  status: string
  sortRaw: string
  setSortRaw: (value: string) => void
  onClearFilters: () => void
  onReload: () => void
  /** The primary "Score my sessions" action, repeated as the empty-state action. */
  startAction: ReactNode
}

const STATUS_LABEL: Record<string, string> = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' }

/** Scoring runs: a sortable table; a row opens the full run page. Polls
 * while any job is queued or running. Filters live in the URL (the page header
 * owns the inputs). */
export function EvalRunsTab({ runs, error, q, status, sortRaw, setSortRaw, onClearFilters, onReload, startAction }: EvalRunsTabProps) {
  const navigate = useNavigate()
  const hasInFlight = runs?.some((r) => isEvalRunInFlight(r.status)) ?? false

  useEffect(() => {
    if (!hasInFlight) return
    const id = window.setInterval(onReload, POLL_MS)
    return () => window.clearInterval(id)
  }, [hasInFlight, onReload])

  const sort = parseSort(sortRaw, EVAL_RUN_SORT_COLUMNS)
  const onSort = (column: string) => setSortRaw(formatSort(nextSort(sort, column)))
  const filtered = useMemo(() => (runs ? filterEvalRuns(runs, { q, status }) : null), [runs, q, status])
  const rows = useMemo(() => (filtered ? sortRows(filtered, sort, evalRunSortKey) : null), [filtered, sort])

  if (error && runs === null) return <ErrorState message={error} onRetry={onReload} />
  if (rows === null) return <TableSkeleton rows={5} columns={5} />
  if (runs?.length === 0) {
    return (
      <EmptyState
        icon={<Play size={22} weight="duotone" />}
        title="No scoring runs yet"
        description="A scoring run asks the eval agent to judge your own chat sessions and stores one score per metric per run."
        action={startAction}
        example="Try it after you have chatted with an agent at least once."
      />
    )
  }
  if (rows.length === 0) return <FilteredEmpty query={q || undefined} what="scoring runs" onClear={onClearFilters} />

  return (
    <>
      {error && <p className="mb-2 text-xs text-rose-700">Live refresh failed: {error} Showing the last loaded list.</p>}
      <Table label="Scoring runs">
        <thead>
          <tr>
            <SortHeader column="created" sort={sort} onSort={onSort}>
              Scoring run
            </SortHeader>
            <SortHeader column="status" sort={sort} onSort={onSort}>
              Status
            </SortHeader>
            <SortHeader column="progress" sort={sort} onSort={onSort}>
              Progress
            </SortHeader>
            <th className="hidden md:table-cell">Judge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <Row key={run.id} onOpen={() => navigate(`/evals/runs/${run.id}`)}>
              <td className="max-w-0 min-w-[10rem]">
                <CopyId value={run.id} label="scoring run ID" />
                <p className="mt-0.5 px-1 text-xs text-zinc-500">
                  {run.scope === 'all' ? 'All users' : 'My sessions'} · <RelativeTime value={run.created_at} />
                </p>
              </td>
              <td>
                <Chip tone={evalStatusTone(run.status)} dot live={run.status === 'running'}>
                  {STATUS_LABEL[run.status] ?? run.status}
                </Chip>
              </td>
              <td>
                <div className="flex items-center gap-2.5">
                  <div className="hidden h-1.5 w-24 overflow-hidden sm:block rounded-full bg-zinc-950/[0.07]" role="progressbar" aria-label="Scoring progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent(run.done, run.total)}>
                    <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${progressPercent(run.done, run.total)}%` }} />
                  </div>
                  <span className="font-data text-xs text-zinc-500 tabular-nums">
                    {run.done}/{run.total}
                  </span>
                </div>
              </td>
              <td className="font-data hidden text-xs text-zinc-600 md:table-cell">{run.judge_model}</td>
            </Row>
          ))}
        </tbody>
      </Table>
    </>
  )
}
