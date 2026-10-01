import type { DashboardWidget } from '../../lib/api-types'
import { Chip } from '../ui'

/** Renders a `list` widget's result as a compact list of
 * title/subtitle/badge rows. */
export function ListWidget({ widget }: { widget: DashboardWidget }) {
  const result = widget.last_result
  if (!result) return null
  if (result.rows.length === 0) {
    return <p className="text-xs text-zinc-500">No rows returned.</p>
  }
  const { title_col, subtitle_col, badge_col } = widget.config

  return (
    <ul className="max-h-72 space-y-1 overflow-y-auto">
      {result.rows.map((row, i) => (
        <li key={i} className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-xs hover:bg-zinc-950/[0.03]">
          <div className="min-w-0">
            <p className="truncate font-medium text-zinc-800">{String(row[title_col!] ?? '')}</p>
            {subtitle_col && <p className="truncate text-xs text-zinc-500">{String(row[subtitle_col] ?? '')}</p>}
          </div>
          {badge_col && row[badge_col] != null && <Chip>{String(row[badge_col])}</Chip>}
        </li>
      ))}
    </ul>
  )
}
