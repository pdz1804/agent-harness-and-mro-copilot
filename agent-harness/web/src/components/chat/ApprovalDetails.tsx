import { CaretRight, Database, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { ApprovalPreview, ApprovalPreviewWidget, DashboardWidget, WidgetQueryResult } from '../../lib/api-types'
import { formatCell, isDashboardPreview, previewHeadline, widgetSummary } from '../../lib/approval-preview'
import { Skeleton } from '../Skeleton'
import { WidgetBody } from '../widgets/WidgetBody'

const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-zinc-100 text-zinc-700',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-rose-100 text-rose-800',
}

const SPAN_CLASS: Record<number, string> = { 3: 'sm:col-span-3', 4: 'sm:col-span-4', 6: 'sm:col-span-6', 12: 'sm:col-span-12' }

function humanize(key: string): string {
  const text = key.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** One proposed widget rendered LIVE: its read-only SQL is executed through
 * the preview endpoint (`POST /queries/preview`, the same dry-run path the
 * tool's precheck used) and drawn with the real widget renderer. Until that
 * returns — or if the caller's role cannot run previews — the dry-run sample
 * rows the tool attached to its approval request are shown instead. */
function LiveWidgetPreview({ widget, index }: { widget: ApprovalPreviewWidget; index: number }) {
  const [live, setLive] = useState<WidgetQueryResult | null>(null)
  const [loading, setLoading] = useState(!widget.error)
  const [liveError, setLiveError] = useState<string | null>(null)

  // Snapshots are re-created on every stream update; key the fetch on the
  // query's content so the live preview runs once per distinct widget.
  const configKey = JSON.stringify(widget.config)
  useEffect(() => {
    if (widget.error) return
    let cancelled = false
    api
      .previewQuery({ sql_query: widget.sql_query, kind: widget.kind, config: JSON.parse(configKey) })
      .then((result) => {
        if (!cancelled) setLive(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLiveError(err instanceof Error ? err.message : 'Live preview unavailable')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [widget.sql_query, widget.kind, configKey, widget.error])

  const asWidget: DashboardWidget = {
    id: `preview-${index}`,
    dashboard_id: '',
    kind: widget.kind,
    title: widget.title,
    sql_query: widget.sql_query,
    config: widget.config,
    position: index,
    col_span: (widget.col_span as DashboardWidget['col_span']) ?? 6,
    last_result: live ?? { columns: widget.columns, rows: widget.sample_rows, truncated: widget.row_count > widget.sample_rows.length },
    last_error: widget.error,
    last_run_ms: null,
    refreshed_at: null,
  }

  return (
    <div className={`col-span-12 min-w-0 rounded-xl bg-white p-3 ring-1 ring-[var(--color-line)] ${SPAN_CLASS[widget.col_span] ?? 'sm:col-span-6'}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-zinc-900">{widget.title}</p>
          <p className="text-[11px] text-zinc-500">
            {widget.kind} · {widget.error ? 'dry run failed' : live ? 'live data' : liveError ? 'dry-run sample' : 'loading live data…'} ·{' '}
            {widgetSummary(widget)}
          </p>
        </div>
      </div>
      {widget.error ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700">
          <WarningCircle size={14} weight="fill" className="mt-px shrink-0" />
          {widget.error}
        </p>
      ) : loading && widget.sample_rows.length === 0 ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <WidgetBody widget={asWidget} />
      )}
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[11px] font-medium text-zinc-500 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
          <CaretRight size={10} weight="bold" className="transition-transform group-open:rotate-90" />
          <Database size={11} weight="bold" aria-hidden="true" />
          Show SQL
        </summary>
        <pre className="font-data mt-1.5 max-h-40 overflow-auto rounded-lg bg-zinc-950 p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-100">
          {widget.sql_query}
        </pre>
        {widget.sample_rows.length > 0 && !live && (
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full text-left text-[11px] tabular-nums">
              <thead>
                <tr className="text-zinc-500">
                  {widget.columns.map((c) => (
                    <th key={c} scope="col" className="px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {widget.sample_rows.map((row, i) => (
                  <tr key={i} className="border-t border-[var(--color-line)] text-zinc-800">
                    {widget.columns.map((c) => (
                      <td key={c} className="font-data px-2 py-1">
                        {formatCell(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  )
}

function DashboardPreview({ preview }: { preview: ApprovalPreview }) {
  return (
    <div>
      <p className="text-sm font-semibold text-zinc-950">{previewHeadline(preview)}</p>
      {preview.description && <p className="mt-0.5 text-[13px] text-zinc-600">{preview.description}</p>}
      {preview.visibility && (
        <p className="mt-0.5 text-xs text-zinc-500">
          Visibility: <span className="font-data">{preview.visibility}</span>
        </p>
      )}
      <div className="mt-3 grid grid-cols-12 gap-2.5">
        {preview.widgets.map((widget, index) => (
          <LiveWidgetPreview key={`${widget.title}-${index}`} widget={widget} index={index} />
        ))}
      </div>
    </div>
  )
}

/** What an approval-gated call will do, as a readable form: a live preview
 * for dashboard tools, otherwise the arguments as labelled fields. The
 * approval API takes a yes/no decision only (`POST /runs/{id}/approve`), so
 * the arguments are shown read-only. */
export function ApprovalDetails({ args, preview }: { args: Record<string, unknown>; preview: unknown }) {
  if (isDashboardPreview(preview as ApprovalPreview | null)) return <DashboardPreview preview={preview as ApprovalPreview} />
  const entries = Object.entries(args)
  if (entries.length === 0) return <p className="text-[13px] text-zinc-500">This call takes no arguments.</p>
  return (
    <dl className="grid gap-x-4 gap-y-2.5 sm:grid-cols-[8rem_1fr]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-xs font-medium text-zinc-500 sm:pt-0.5">{humanize(key)}</dt>
          <dd className="min-w-0 text-[13px] text-zinc-900 [overflow-wrap:anywhere]">
            {key === 'severity' && typeof value === 'string' ? (
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[value] ?? SEVERITY_STYLES.medium}`}>
                {value}
              </span>
            ) : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? (
              String(value)
            ) : (
              <pre className="font-data overflow-x-auto rounded-lg bg-zinc-50 p-2 text-xs text-zinc-700 ring-1 ring-[var(--color-line)]">
                {JSON.stringify(value, null, 2)}
              </pre>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
