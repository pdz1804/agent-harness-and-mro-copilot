import { METRIC_LABELS, METRIC_TOOLTIPS, RAW_VALUE_METRICS, formatMetricValue } from '../../lib/eval-shapes'
import { resultVerdict, type ResultVerdict } from '../../lib/evals-runs'
import type { EvalResultRow } from '../../lib/api-types'
import type { SortState } from '../../lib/table-sort'
import { Chip, Row, SortHeader, Table, type ChipTone } from '../ui'

export function scoreColor(row: EvalResultRow): string {
  if (row.score === null) return 'text-zinc-500'
  if (RAW_VALUE_METRICS.has(row.metric)) return 'text-zinc-700'
  if (row.score >= 0.75) return 'text-emerald-700'
  if (row.score >= 0.5) return 'text-amber-700'
  return 'text-rose-700'
}

const VERDICT_CHIP: Record<ResultVerdict, { label: string; tone: ChipTone }> = {
  unavailable: { label: 'Unavailable', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  passed: { label: 'Passed', tone: 'ok' },
  recorded: { label: 'Recorded', tone: 'neutral' },
}

export function VerdictChip({ row }: { row: EvalResultRow }) {
  const { label, tone } = VERDICT_CHIP[resultVerdict(row)]
  return (
    <Chip tone={tone} dot>
      {label}
    </Chip>
  )
}

interface RunScoreTableProps {
  results: EvalResultRow[]
  /** The result whose sheet is open (highlighted row). */
  openId: string | null
  onOpen: (id: string) => void
  sort: SortState | null
  onSort: (column: string) => void
  agentLabel: (id: string | null) => string
}

/** One row per scored `(run, metric)` pair; a row opens the item sheet with
 * the judge rationale and the feedback control. */
export function RunScoreTable({ results, openId, onOpen, sort, onSort, agentLabel }: RunScoreTableProps) {
  return (
    <Table label="Scored metrics">
      <thead>
        <tr>
          <SortHeader column="run" sort={sort} onSort={onSort}>
            Run
          </SortHeader>
          <SortHeader column="metric" sort={sort} onSort={onSort}>
            Metric
          </SortHeader>
          <SortHeader column="score" sort={sort} onSort={onSort} align="right" className="text-right">
            Score
          </SortHeader>
          <th>Status</th>
          <th className="hidden md:table-cell">Agent</th>
        </tr>
      </thead>
      <tbody>
        {results.map((row) => (
          <Row key={row.id} onOpen={() => onOpen(row.id)} selected={row.id === openId}>
            <td className="max-w-[10rem]">
              <span className="font-data block truncate text-xs text-zinc-600" title={row.run_id}>
                {row.run_id}
              </span>
            </td>
            <td className="font-medium text-zinc-800" title={METRIC_TOOLTIPS[row.metric]}>
              {METRIC_LABELS[row.metric] ?? row.metric}
            </td>
            <td className={`font-data text-right font-semibold tabular-nums ${scoreColor(row)}`}>{formatMetricValue(row.metric, row.score)}</td>
            <td>
              <VerdictChip row={row} />
            </td>
            <td className="hidden max-w-[10rem] truncate text-zinc-600 md:table-cell">{agentLabel(row.agent_id)}</td>
          </Row>
        ))}
      </tbody>
    </Table>
  )
}
