import { ArrowClockwise, PencilSimple, Trash, WarningCircle } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Skeleton } from '../Skeleton'
import type { DashboardWidget } from '../../lib/api-types'
import { ConfirmButton } from '../ui/ConfirmButton'

const COL_SPAN_CLASS: Record<number, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  12: 'md:col-span-12',
}

function formatRefreshedAt(value: string | null): string {
  if (!value) return 'never refreshed'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleString()
}

/** Shared chrome for every widget kind: title, refreshed-at/latency, a
 * per-widget "Refresh" button, error state (renders in place of the
 * widget's own content — the rest of the dashboard's other widgets are
 * untouched, see `DashboardPage`), and an edit-mode menu. */
export function WidgetFrame({
  widget,
  editMode,
  refreshing,
  onRefresh,
  onEdit,
  onDelete,
  children,
}: {
  widget: DashboardWidget
  editMode: boolean
  refreshing: boolean
  onRefresh: () => void
  onEdit?: () => void
  onDelete?: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`ui-card flex min-w-0 flex-col p-4 ${COL_SPAN_CLASS[widget.col_span] ?? 'md:col-span-6'} col-span-1`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-zinc-900">{widget.title}</p>
          <p className="text-[11px] text-zinc-400">
            {formatRefreshedAt(widget.refreshed_at)}
            {widget.last_run_ms != null && ` · ${widget.last_run_ms}ms`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={`Refresh ${widget.title}`}
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
          >
            <ArrowClockwise size={14} weight="bold" className={refreshing ? 'animate-spin' : ''} />
          </button>
          {editMode && onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${widget.title}`}
              className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
            >
              <PencilSimple size={14} weight="bold" />
            </button>
          )}
          {editMode && onDelete && (
            <ConfirmButton
              prompt={`Delete widget "${widget.title}"?`}
              onConfirm={onDelete}
              ariaLabel={`Delete ${widget.title}`}
              className="rounded-md p-1.5 text-zinc-500 transition-colors duration-150 hover:bg-rose-50 hover:text-rose-600"
            >
              <Trash size={14} weight="bold" />
            </ConfirmButton>
          )}
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1">
        {refreshing && !widget.last_result && !widget.last_error ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : widget.last_error ? (
          <div className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
            <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-rose-500" />
            <span>{widget.last_error}</span>
          </div>
        ) : widget.last_result ? (
          <>
            {children}
            {widget.last_result.truncated && (
              <p className="mt-2 text-xs text-amber-600">
                Result truncated to the first {widget.last_result.rows.length.toLocaleString()} rows.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-zinc-500">Not refreshed yet.</p>
        )}
      </div>
    </div>
  )
}
