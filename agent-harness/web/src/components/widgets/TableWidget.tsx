import { useState } from 'react'
import { paginateRows } from '../../lib/widget-shapes'
import type { DashboardWidget } from '../../lib/api-types'

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
      <div className="max-h-72 overflow-auto rounded-lg border border-zinc-200">
        <table className="ui-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col} title={col} className="max-w-[16rem] truncate px-3 py-2">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {pageRows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => {
                  const value = String(row[col] ?? '')
                  return (
                    <td
                      key={col}
                      title={value}
                      className={`max-w-[16rem] truncate px-3 py-1.5 font-data text-zinc-800 ${
                        typeof row[col] === 'number' ? 'text-right' : ''
                      }`}
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
          <button
            type="button"
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            Page {clampedPage + 1} of {totalPages}
          </span>
          <button
            type="button"
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
