import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { DashboardWidget } from '../../lib/api-types'
import { Button, Card, RelativeTime, RowActions, Skeleton, type RowAction } from '../ui'

const COL_SPAN_CLASS: Record<number, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  12: 'md:col-span-12',
}

/** Shared chrome for every widget kind: title, refreshed-at and latency, a
 * per-widget refresh button, a ⋯ menu (edit, move, delete), and an error state
 * that renders in place of the widget body, so one failing widget never
 * affects its siblings (see `DashboardPage`). */
export function WidgetFrame({
  widget,
  refreshing,
  onRefresh,
  onOpen,
  actions,
  selected,
  children,
}: {
  widget: DashboardWidget
  refreshing: boolean
  onRefresh: () => void
  /** Clicking the title opens the widget editor sheet. */
  onOpen?: () => void
  actions: RowAction[]
  /** The widget currently open in the editor sheet. */
  selected?: boolean
  children: ReactNode
}) {
  return (
    <Card
      as="section"
      selected={selected}
      aria-label={widget.title}
      className={`flex flex-col ${COL_SPAN_CLASS[widget.col_span] ?? 'md:col-span-6'} col-span-1`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              title="Open widget settings"
              className="block max-w-full truncate rounded text-left text-[13px] font-medium text-zinc-900 hover:text-sky-700"
            >
              {widget.title}
            </button>
          ) : (
            <p className="truncate text-[13px] font-medium text-zinc-900">{widget.title}</p>
          )}
          <p className="text-[11px] text-zinc-500">
            {widget.refreshed_at ? (
              <>
                Updated <RelativeTime value={widget.refreshed_at} />
              </>
            ) : (
              'Never refreshed'
            )}
            {widget.last_run_ms != null && <span className="tabular-nums">{` · ${widget.last_run_ms} ms`}</span>}
          </p>
        </div>
        <div className="-mt-1 -mr-1 flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<ArrowClockwise size={14} weight="bold" />}
            loading={refreshing}
            onClick={onRefresh}
            aria-label={`Refresh ${widget.title}`}
            title="Re-run this query"
          />
          <RowActions visibility="always" label={`More actions for ${widget.title}`} items={actions} />
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1">
        {refreshing && !widget.last_result && !widget.last_error ? (
          <Skeleton className="h-24 w-full" />
        ) : widget.last_error ? (
          <div role="alert" className="flex items-start gap-2 rounded-[10px] bg-rose-50 px-3 py-2.5 text-xs text-rose-800">
            <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-rose-600" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{widget.last_error}</span>
            <Button variant="secondary" size="sm" onClick={onRefresh} loading={refreshing}>
              Retry
            </Button>
          </div>
        ) : widget.last_result ? (
          <>
            {children}
            {widget.last_result.truncated && (
              <p className="mt-2 text-xs text-amber-700">Result truncated to the first {widget.last_result.rows.length.toLocaleString()} rows.</p>
            )}
          </>
        ) : (
          <p className="text-xs text-zinc-500">Not refreshed yet. Use the refresh button to run its query.</p>
        )}
      </div>
    </Card>
  )
}
