import { useState } from 'react'
import { X } from '@phosphor-icons/react'
import { ApiError, api } from '../../lib/api'
import { validateWidgetConfigClient } from '../../lib/widget-shapes'
import type { DashboardWidget, WidgetConfig, WidgetKind, WidgetQueryResult } from '../../lib/api-types'

const KINDS: WidgetKind[] = ['stat', 'line', 'bar', 'area', 'pie', 'table', 'list']
const COL_SPANS = [3, 4, 6, 12] as const

interface FormState {
  kind: WidgetKind
  title: string
  sql_query: string
  col_span: 3 | 4 | 6 | 12
  config: WidgetConfig
}

function emptyForm(): FormState {
  return { kind: 'stat', title: '', sql_query: '', col_span: 6, config: { value_col: 'value' } }
}

function toForm(widget: DashboardWidget): FormState {
  return {
    kind: widget.kind,
    title: widget.title,
    sql_query: widget.sql_query,
    col_span: widget.col_span,
    config: widget.config,
  }
}

/** Widget create/edit drawer: kind picker, SQL editor, a config mapping
 * form specific to the chosen kind, and a "Test" button that calls
 * `POST /queries/preview` (runs the query for real against the live
 * database, validated the same way a saved widget's query would be, but
 * persists nothing) so the author can see real columns/rows and a
 * rendered shape-check result before saving. */
export function WidgetEditor({
  dashboardId,
  widget,
  onClose,
  onSaved,
}: {
  dashboardId: string
  widget: DashboardWidget | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(widget ? toForm(widget) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WidgetQueryResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const isNew = widget === null

  const setConfig = (patch: Partial<WidgetConfig>) => setForm((f) => ({ ...f, config: { ...f.config, ...patch } }))
  const configError = validateWidgetConfigClient(form.kind, form.config)

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const result = await api.previewQuery({ sql_query: form.sql_query, kind: form.kind, config: form.config })
      setTestResult(result)
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : 'Failed to run query.')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      if (isNew) {
        await api.createWidget(dashboardId, {
          kind: form.kind,
          title: form.title.trim(),
          sql_query: form.sql_query.trim(),
          config: form.config,
          col_span: form.col_span,
        })
      } else {
        await api.updateWidget(dashboardId, widget.id, {
          title: form.title.trim(),
          sql_query: form.sql_query.trim(),
          config: form.config,
          col_span: form.col_span,
        })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save widget.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40">
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-zinc-900">{isNew ? 'New widget' : `Edit ${widget.title}`}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X size={16} weight="bold" />
          </button>
        </div>

        <div className="flex-1 space-y-4 px-5 py-4">
          {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}

          <label className="block text-xs font-medium text-zinc-600">
            Title
            <input name="widget-title" autoComplete="off"
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </label>

          <div className="flex items-center gap-4">
            <label className="block text-xs font-medium text-zinc-600">
              Kind
              <select name="widget-kind"
                value={form.kind}
                disabled={!isNew}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as WidgetKind }))}
                className="mt-1 block rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-60"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              Width
              <select name="widget-width"
                value={form.col_span}
                onChange={(e) => setForm((f) => ({ ...f, col_span: Number(e.target.value) as FormState['col_span'] }))}
                className="mt-1 block rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              >
                {COL_SPANS.map((c) => (
                  <option key={c} value={c}>
                    {c}/12
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-xs font-medium text-zinc-600">
            SQL query (read-only SELECT only)
            <textarea name="widget-sql" autoComplete="off"
              value={form.sql_query}
              onChange={(e) => setForm((f) => ({ ...f, sql_query: e.target.value }))}
              rows={5}
              placeholder="SELECT status, count(*) AS n FROM services GROUP BY status…"
              className="mt-1 w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 font-data text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Write/DDL keywords and multiple statements are rejected; execution is timeout- and row-capped.
            </span>
          </label>

          <ConfigFields kind={form.kind} config={form.config} onChange={setConfig} />
          {configError && <p className="text-xs font-medium text-amber-600">{configError}</p>}

          <div>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || !form.sql_query.trim() || !!configError}
              className="ui-btn ui-btn-secondary ui-btn-sm"
            >
              {testing ? 'Testing…' : 'Test query'}
            </button>
            {testError && <p className="mt-2 text-xs font-medium text-rose-600">{testError}</p>}
            {testResult && (
              <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-zinc-200">
                <table className="ui-table">
                  <thead>
                    <tr>
                      {testResult.columns.map((c) => (
                        <th key={c} className="px-2 py-1.5 whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {testResult.rows.slice(0, 20).map((row, i) => (
                      <tr key={i}>
                        {testResult.columns.map((c) => (
                          <td key={c} className="px-2 py-1 font-data whitespace-nowrap text-zinc-800">
                            {String(row[c] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-zinc-200 px-5 py-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !form.title.trim() || !form.sql_query.trim() || !!configError}
            className="ui-btn ui-btn-primary ui-btn-sm"
          >
            {saving ? 'Saving…' : isNew ? 'Create widget' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function textField(label: string, value: string, onChange: (v: string) => void, placeholder?: string) {
  return (
    <label className="block text-xs font-medium text-zinc-600">
      {label}
      <input name="widget-config-field" autoComplete="off"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-data focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
      />
    </label>
  )
}

/** The config sub-form varies by `kind` — mirrors `agent_harness.widget_config`'s
 * per-kind Pydantic model field-for-field. */
function ConfigFields({
  kind,
  config,
  onChange,
}: {
  kind: WidgetKind
  config: WidgetConfig
  onChange: (patch: Partial<WidgetConfig>) => void
}) {
  if (kind === 'stat') {
    return (
      <div className="space-y-3 rounded-md bg-zinc-50 p-3">
        {textField('Value column', config.value_col ?? '', (v) => onChange({ value_col: v }), 'value')}
        <label className="block text-xs font-medium text-zinc-600">
          Format
          <select name="widget-format"
            value={config.format ?? 'number'}
            onChange={(e) => onChange({ format: e.target.value as WidgetConfig['format'] })}
            className="mt-1 block rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
          >
            <option value="number">number</option>
            <option value="percent">percent</option>
            <option value="duration_ms">duration_ms</option>
            <option value="currency">currency</option>
          </select>
        </label>
        {textField('Delta column (optional)', config.delta_col ?? '', (v) => onChange({ delta_col: v || null }))}
      </div>
    )
  }
  if (kind === 'line' || kind === 'bar' || kind === 'area') {
    return (
      <div className="space-y-3 rounded-md bg-zinc-50 p-3">
        {textField('X column', config.x_col ?? '', (v) => onChange({ x_col: v }), 'day')}
        {textField(
          'Y columns (comma-separated)',
          (config.y_cols ?? []).join(', '),
          (v) => onChange({ y_cols: v.split(',').map((s) => s.trim()).filter(Boolean) }),
          'n, tokens',
        )}
        <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
          <input name="widget-stacked"
            type="checkbox"
            checked={!!config.stacked}
            onChange={(e) => onChange({ stacked: e.target.checked })}
            className="h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
          />
          Stacked
        </label>
      </div>
    )
  }
  if (kind === 'pie') {
    return (
      <div className="space-y-3 rounded-md bg-zinc-50 p-3">
        {textField('Label column', config.label_col ?? '', (v) => onChange({ label_col: v }), 'label')}
        {textField('Value column', config.value_col ?? '', (v) => onChange({ value_col: v }), 'n')}
      </div>
    )
  }
  if (kind === 'table') {
    return (
      <div className="space-y-3 rounded-md bg-zinc-50 p-3">
        {textField(
          'Columns (optional, comma-separated — blank = all)',
          (config.columns ?? []).join(', '),
          (v) => onChange({ columns: v.trim() ? v.split(',').map((s) => s.trim()) : null }),
        )}
        <label className="block text-xs font-medium text-zinc-600">
          Page size
          <input name="widget-page-size" autoComplete="off"
            type="number"
            min={1}
            max={500}
            value={config.page_size ?? 20}
            onChange={(e) => onChange({ page_size: Number(e.target.value) })}
            className="mt-1 w-24 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
          />
        </label>
      </div>
    )
  }
  // list
  return (
    <div className="space-y-3 rounded-md bg-zinc-50 p-3">
      {textField('Title column', config.title_col ?? '', (v) => onChange({ title_col: v }), 'title')}
      {textField('Subtitle column (optional)', config.subtitle_col ?? '', (v) => onChange({ subtitle_col: v || null }))}
      {textField('Badge column (optional)', config.badge_col ?? '', (v) => onChange({ badge_col: v || null }))}
    </div>
  )
}
