import { Fragment, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { METRIC_LABELS, METRIC_TOOLTIPS, RAW_VALUE_METRICS, formatMetricValue } from '../../lib/eval-shapes'
import type { EvalResultRow } from '../../lib/api-types'

function formatScore(row: EvalResultRow): string {
  return formatMetricValue(row.metric, row.score)
}

function scoreColor(row: EvalResultRow): string {
  if (row.score === null) return 'text-zinc-500'
  if (RAW_VALUE_METRICS.has(row.metric)) return 'text-zinc-700'
  if (row.score >= 0.75) return 'text-emerald-700'
  if (row.score >= 0.5) return 'text-amber-700'
  return 'text-rose-700'
}

/** Per-run metric table with an expandable judge rationale per row —
 * backs the run drill-down's "metric scores + judge rationale + trace
 * metrics" requirement. `run_id` filters to one run's rows when the same
 * component is reused for a multi-run eval job's result list. */
export function RunScoreTable({ results, runId }: { results: EvalResultRow[]; runId?: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const rows = runId ? results.filter((r) => r.run_id === runId) : results

  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No results.</p>
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs text-zinc-500">
            {!runId && <th className="py-2 pr-3">Run</th>}
            <th className="py-2 pr-3">Metric</th>
            <th className="py-2 pr-3">Score</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isExpanded = expanded.has(row.id)
            return (
              <Fragment key={row.id}>
                <tr
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                  onClick={() => toggle(row.id)}
                >
                  {!runId && <td className="py-2 pr-3 font-data text-xs text-zinc-600">{row.run_id}</td>}
                  <td className="py-2 pr-3 font-medium text-zinc-800">
                    <span className="inline-flex items-center gap-1" title={METRIC_TOOLTIPS[row.metric]}>
                      {row.rationale ? (
                        isExpanded ? (
                          <CaretDown size={12} weight="bold" className="text-zinc-500" />
                        ) : (
                          <CaretRight size={12} weight="bold" className="text-zinc-500" />
                        )
                      ) : (
                        <span className="w-3" />
                      )}
                      {METRIC_LABELS[row.metric] ?? row.metric}
                    </span>
                  </td>
                  <td className={`py-2 pr-3 font-data font-semibold ${scoreColor(row)}`}>{formatScore(row)}</td>
                  <td className="py-2 text-xs text-zinc-500">
                    {row.score === null ? 'unavailable / error' : row.passed === false ? 'failed' : 'ok'}
                  </td>
                </tr>
                {isExpanded && row.rationale && (
                  <tr className="border-b border-zinc-100 bg-zinc-50/60">
                    <td colSpan={runId ? 3 : 4} className="px-3 py-2 text-xs text-zinc-600">
                      {row.rationale}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
