import { useState } from 'react'
import { paginateRows } from '../../lib/widget-shapes'
import type { DashboardWidget } from '../../lib/api-types'
import { Button, Table } from '../ui'

/** Renders a `table` widget's result as a simple paginated table
 * (`config.page_size`), optionally restricted to `config.columns`. */
export function TableWidget({ widget }: { widget: DashboardWidget }) {
  const [page, setPage] = useState(0)
  const result = widget.last_result
  if (!result) return null
  const columns = widget.config.columns?.length ? widget.config.columns : result.columns
  const { pageRows, totalPages, page: clampedPage } = paginateRows(result.rows, widget.config.page_size ?? 20, page)

  if (result.rows.length === 0) {
    return <p className="text-xs text-zinc-500">No rows returned.</p>
  }

  return (
    <div>
      <Table label={widget.title} className="max-h-72 overflow-auto">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col} title={col} className="max-w-[16rem] truncate">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => {
                const value = String(row[col] ?? '')
                return (
                  <td key={col} title={value} className={`font-data max-w-[16rem] truncate text-zinc-800 ${typeof row[col] === 'number' ? 'text-right tabular-nums' : ''}`}>
                    {value}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      {totalPages > 1 && (
        <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
          <Button variant="ghost" size="sm" disabled={clampedPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <span className="tabular-nums">
            Page {clampedPage + 1} of {totalPages}
          </span>
          <Button variant="ghost" size="sm" disabled={clampedPage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
