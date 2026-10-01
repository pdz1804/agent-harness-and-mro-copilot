/** Pure, framework-free helpers for dashboard widgets (phase 06): client-
 * side config validation (mirrors `agent_harness.widget_config`'s per-kind
 * required fields, so the editor can show/disable before ever hitting the
 * network) and result-shaping helpers (`paginateRows`/`buildPieData`) used
 * by `TableWidget`/`ChartWidget`. Kept dependency-free so it can be unit
 * tested in plain `vitest` (`tests/widget-shapes.test.ts`) without a DOM. */

import type { WidgetConfig, WidgetKind } from './api-types'

export function validateWidgetConfigClient(kind: WidgetKind, config: WidgetConfig): string | null {
  switch (kind) {
    case 'stat':
      if (!config.value_col?.trim()) return 'Stat widgets require a value column.'
      return null
    case 'line':
    case 'bar':
    case 'area':
      if (!config.x_col?.trim()) return `${kind} widgets require an X column.`
      if (!config.y_cols || config.y_cols.length === 0) return `${kind} widgets require at least one Y column.`
      return null
    case 'pie':
      if (!config.label_col?.trim()) return 'Pie widgets require a label column.'
      if (!config.value_col?.trim()) return 'Pie widgets require a value column.'
      return null
    case 'table':
      if (config.page_size != null && (config.page_size < 1 || config.page_size > 500)) {
        return 'Page size must be between 1 and 500.'
      }
      return null
    case 'list':
      if (!config.title_col?.trim()) return 'List widgets require a title column.'
      return null
    default:
      return `Unknown widget kind '${kind}'.`
  }
}

/** Slice `rows` into one page of `pageSize` rows (0-indexed `page`,
 * clamped into range) — the same pagination `TableWidget` renders. */
export function paginateRows<T>(rows: T[], pageSize: number, page: number): { pageRows: T[]; totalPages: number; page: number } {
  const size = Math.max(1, pageSize)
  const totalPages = Math.max(1, Math.ceil(rows.length / size))
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1)
  return { pageRows: rows.slice(clampedPage * size, clampedPage * size + size), totalPages, page: clampedPage }
}

/** A `line`/`area` chart with fewer than 2 rows renders as an invisible,
 * dot-less trend line (phase 06 polish note). Bars remain legible with a
 * single data point, so those widget kinds fall back to a bar rendering
 * (with an explanatory note) instead. */
export function needsSparseTrendFallback(kind: WidgetKind, rowCount: number): boolean {
  return (kind === 'line' || kind === 'area') && rowCount < 2
}

/** Shape a raw query result's rows into recharts-ready pie slices,
 * coercing the value column to a number (a non-numeric/missing value
 * becomes 0 rather than `NaN`, so a malformed row never breaks the whole
 * chart). */
export function buildPieData(
  rows: Record<string, unknown>[],
  labelCol: string,
  valueCol: string,
): { name: string; value: number }[] {
  return rows.map((row) => {
    const raw = row[valueCol]
    const value = typeof raw === 'number' ? raw : Number(raw)
    return { name: String(row[labelCol] ?? ''), value: Number.isNaN(value) ? 0 : value }
  })
}
