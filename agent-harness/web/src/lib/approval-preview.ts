import type { ApprovalPreview, ApprovalPreviewWidget } from './api-types'

export function isDashboardPreview(preview: ApprovalPreview | null | undefined): preview is ApprovalPreview {
  return !!preview && (preview.kind === 'dashboard' || preview.kind === 'widget') && Array.isArray(preview.widgets)
}

export function previewHeadline(preview: ApprovalPreview): string {
  const n = preview.widgets.length
  if (preview.kind === 'widget') return `Add 1 widget to dashboard "${preview.name}"`
  return `Create dashboard "${preview.name}" with ${n} widget${n === 1 ? '' : 's'}`
}

export function widgetSummary(widget: ApprovalPreviewWidget): string {
  if (widget.error) return `dry run failed: ${widget.error}`
  const rows = `${widget.row_count} row${widget.row_count === 1 ? '' : 's'}`
  return `${rows} · ${widget.columns.length} column${widget.columns.length === 1 ? '' : 's'}`
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return String(value)
}
