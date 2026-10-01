import { Play, Trash } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { api, errorText } from '../../lib/api'
import { validateWidgetConfigClient } from '../../lib/widget-shapes'
import type { DashboardWidget, WidgetConfig, WidgetKind, WidgetQueryResult } from '../../lib/api-types'
import { Button, Chip, ConfirmPopover, ErrorBanner, Field, Input, Select, Sheet, SheetSection, Skeleton, Switch, Table, Textarea } from '../ui'
import { DiscardBar } from './DiscardBar'

const KINDS: WidgetKind[] = ['stat', 'line', 'bar', 'area', 'pie', 'table', 'list']
const KIND_LABEL: Record<WidgetKind, string> = {
  stat: 'Stat (one number)',
  line: 'Line chart',
  bar: 'Bar chart',
  area: 'Area chart',
  pie: 'Pie chart',
  table: 'Table',
  list: 'List',
}
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
  return { kind: widget.kind, title: widget.title, sql_query: widget.sql_query, col_span: widget.col_span, config: widget.config }
}

type Touched = Partial<Record<'title' | 'sql', boolean>>

/** Widget create/edit sheet: kind picker, SQL editor, a config mapping form
 * specific to the chosen kind, and a "Run preview" button that calls
 * `POST /queries/preview` (runs the query for real against the live
 * database, validated like a saved widget's query, persisting nothing) so the
 * author sees real columns and rows before saving. Closing with unsaved edits
 * asks first. */
export function WidgetEditor({
  dashboardId,
  dashboardName,
  widget,
  position,
  canWrite,
  writeReason,
  onClose,
  onPrev,
  onNext,
  onSaved,
  onDelete,
}: {
  dashboardId: string
  dashboardName: string
  widget: DashboardWidget | null
  /** "widget 2 of 5" facts for an existing widget. */
  position?: { index: number; total: number }
  canWrite: boolean
  writeReason?: string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Called after a successful save with the stored widget and its previous version (null when created). */
  onSaved: (saved: DashboardWidget, previous: DashboardWidget | null) => void
  onDelete?: (widget: DashboardWidget) => void
}) {
  const initial = useMemo(() => (widget ? toForm(widget) : emptyForm()), [widget])
  const [form, setForm] = useState<FormState>(initial)
  const [touched, setTouched] = useState<Touched>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WidgetQueryResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const isNew = widget === null

  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const setConfig = (patch: Partial<WidgetConfig>) => setForm((f) => ({ ...f, config: { ...f.config, ...patch } }))
  const configError = validateWidgetConfigClient(form.kind, form.config)
  const titleError = !form.title.trim() ? 'Give the widget a title.' : null
  const sqlError = !form.sql_query.trim() ? 'Enter a read-only SELECT query.' : null

  const requestClose = () => {
    if (dirty && !saving) setConfirmingDiscard(true)
    else onClose()
  }

  const handleTest = async () => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(await api.previewQuery({ sql_query: form.sql_query, kind: form.kind, config: form.config }))
    } catch (err) {
      setTestError(errorText(err, 'Could not run the query.'))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setTouched({ title: true, sql: true })
    if (titleError || sqlError || configError) return
    setSaving(true)
    setError(null)
    try {
      const body = { title: form.title.trim(), sql_query: form.sql_query.trim(), config: form.config, col_span: form.col_span }
      const saved = isNew ? await api.createWidget(dashboardId, { kind: form.kind, ...body }) : await api.updateWidget(dashboardId, widget.id, body)
      onSaved(saved, widget)
    } catch (err) {
      setError(errorText(err, 'Could not save the widget.'))
    } finally {
      setSaving(false)
    }
  }

  const disabledTitle = canWrite ? undefined : writeReason
  const title = isNew ? 'New widget' : 'Edit widget'

  return (
    <Sheet
      open
      onClose={requestClose}
      onPrev={dirty ? undefined : onPrev}
      onNext={dirty ? undefined : onNext}
      width="lg"
      eyebrow={`Dashboards / ${dashboardName}`}
      title={title}
      status={dirty ? <Chip tone="warn" dot>Unsaved changes</Chip> : undefined}
      meta={
        position ? (
          <span>
            {widget?.title} · widget {position.index + 1} of {position.total}
          </span>
        ) : (
          <span>Runs a stored read-only query each time it refreshes.</span>
        )
      }
      footer={
        <>
          {!isNew && onDelete && (
            <ConfirmPopover
              size="md"
              icon={<Trash size={14} />}
              prompt={`Delete widget “${widget.title}”?`}
              description="You can undo for a few seconds."
              confirmLabel="Delete widget"
              disabled={!canWrite}
              title={disabledTitle}
              align="start"
              className="mr-auto"
              onConfirm={() => onDelete(widget)}
            >
              Delete widget
            </ConfirmPopover>
          )}
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!canWrite} title={disabledTitle} onClick={() => void handleSave()}>
            {isNew ? 'Create widget' : 'Save widget'}
          </Button>
        </>
      }
    >
      {confirmingDiscard && <DiscardBar onKeep={() => setConfirmingDiscard(false)} onDiscard={onClose} />}
      {!canWrite && <p className="mb-4 rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">{writeReason} You can look at this widget but not change it.</p>}
      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      <SheetSection title="Basics">
        <div className="space-y-3">
          <Field label="Title" error={touched.title ? titleError : null}>
            {(p) => (
              <Input
                {...p}
                name="widget-title"
                autoComplete="off"
                value={form.title}
                disabled={!canWrite}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, title: true }))}
                className="w-full"
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type" hint={isNew ? undefined : 'A widget keeps its type once created.'}>
              {(p) => (
                <Select {...p} name="widget-kind" value={form.kind} disabled={!isNew || !canWrite} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as WidgetKind }))} className="w-full">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Width">
              {(p) => (
                <Select
                  {...p}
                  name="widget-width"
                  value={form.col_span}
                  disabled={!canWrite}
                  onChange={(e) => setForm((f) => ({ ...f, col_span: Number(e.target.value) as FormState['col_span'] }))}
                  className="w-full"
                >
                  {COL_SPANS.map((c) => (
                    <option key={c} value={c}>
                      {c} of 12 columns
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </div>
      </SheetSection>

      <SheetSection title="Query">
        <Field
          label="SQL (read-only)"
          error={touched.sql ? sqlError : null}
          hint="One SELECT statement. Write and DDL keywords are rejected; execution is timeout- and row-capped."
        >
          {(p) => (
            <Textarea
              {...p}
              name="widget-sql"
              autoComplete="off"
              spellCheck={false}
              rows={5}
              value={form.sql_query}
              disabled={!canWrite}
              placeholder="SELECT status, count(*) AS n FROM services GROUP BY status"
              onChange={(e) => setForm((f) => ({ ...f, sql_query: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, sql: true }))}
              className="font-data !h-auto w-full resize-y py-2 text-[13px] leading-5"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Play size={12} weight="fill" />} loading={testing} disabled={!form.sql_query.trim() || !!configError} onClick={() => void handleTest()}>
            Run preview
          </Button>
          {testResult && !testing && (
            <>
              <Chip tone="ok" dot>
                Query passed
              </Chip>
              <span className="text-xs text-zinc-500 tabular-nums">
                {testResult.rows.length} row{testResult.rows.length === 1 ? '' : 's'}
                {testResult.truncated ? ' (truncated)' : ''}
              </span>
            </>
          )}
        </div>
        {testing && <Skeleton className="h-24 w-full" />}
        {testError && !testing && (
          <p role="alert" className="rounded-[10px] bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 [overflow-wrap:anywhere]">
            {testError}
          </p>
        )}
        {testResult && !testing && (
          <Table label="Query preview" className="max-h-56 overflow-auto">
            <thead>
              <tr>
                {testResult.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {testResult.rows.slice(0, 20).map((row, i) => (
                <tr key={i}>
                  {testResult.columns.map((c) => (
                    <td key={c} className="font-data whitespace-nowrap text-zinc-800">
                      {String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </SheetSection>

      <SheetSection title="Display">
        <ConfigFields kind={form.kind} config={form.config} disabled={!canWrite} onChange={setConfig} />
        {configError && <p className="text-xs font-medium text-amber-700">{configError}</p>}
      </SheetSection>
    </Sheet>
  )
}

function ColumnField({ label, value, onChange, placeholder, disabled, optional }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled: boolean; optional?: boolean }) {
  return (
    <Field label={label} optional={optional}>
      {(p) => <Input {...p} name="widget-config-field" autoComplete="off" value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="font-data w-full" />}
    </Field>
  )
}

/** The config sub-form varies by `kind`: it mirrors `agent_harness.widget_config`'s
 * per-kind Pydantic model field for field. */
function ConfigFields({ kind, config, disabled, onChange }: { kind: WidgetKind; config: WidgetConfig; disabled: boolean; onChange: (patch: Partial<WidgetConfig>) => void }) {
  if (kind === 'stat') {
    return (
      <div className="space-y-3">
        <ColumnField label="Value column" value={config.value_col ?? ''} onChange={(v) => onChange({ value_col: v })} placeholder="value" disabled={disabled} />
        <Field label="Format">
          {(p) => (
            <Select {...p} name="widget-format" value={config.format ?? 'number'} disabled={disabled} onChange={(e) => onChange({ format: e.target.value as WidgetConfig['format'] })} className="w-full">
              <option value="number">Number</option>
              <option value="percent">Percent</option>
              <option value="duration_ms">Duration (ms)</option>
              <option value="currency">Currency</option>
            </Select>
          )}
        </Field>
        <ColumnField label="Delta column" optional value={config.delta_col ?? ''} onChange={(v) => onChange({ delta_col: v || null })} disabled={disabled} />
      </div>
    )
  }
  if (kind === 'line' || kind === 'bar' || kind === 'area') {
    return (
      <div className="space-y-3">
        <ColumnField label="X column" value={config.x_col ?? ''} onChange={(v) => onChange({ x_col: v })} placeholder="day" disabled={disabled} />
        <ColumnField
          label="Y columns"
          value={(config.y_cols ?? []).join(', ')}
          onChange={(v) => onChange({ y_cols: v.split(',').map((s) => s.trim()).filter(Boolean) })}
          placeholder="n, tokens"
          disabled={disabled}
        />
        <div className="flex items-center gap-2 text-[13px] text-zinc-800">
          <Switch label="Stacked" checked={!!config.stacked} disabled={disabled} onChange={(next) => onChange({ stacked: next })} />
          Stacked
        </div>
      </div>
    )
  }
  if (kind === 'pie') {
    return (
      <div className="space-y-3">
        <ColumnField label="Label column" value={config.label_col ?? ''} onChange={(v) => onChange({ label_col: v })} placeholder="label" disabled={disabled} />
        <ColumnField label="Value column" value={config.value_col ?? ''} onChange={(v) => onChange({ value_col: v })} placeholder="n" disabled={disabled} />
      </div>
    )
  }
  if (kind === 'table') {
    return (
      <div className="space-y-3">
        <ColumnField
          label="Columns"
          optional
          value={(config.columns ?? []).join(', ')}
          onChange={(v) => onChange({ columns: v.trim() ? v.split(',').map((s) => s.trim()) : null })}
          placeholder="Blank shows every column"
          disabled={disabled}
        />
        <Field label="Page size" hint="Between 1 and 500 rows.">
          {(p) => (
            <Input
              {...p}
              name="widget-page-size"
              autoComplete="off"
              type="number"
              min={1}
              max={500}
              value={config.page_size ?? 20}
              disabled={disabled}
              onChange={(e) => onChange({ page_size: Number(e.target.value) })}
              className="w-28 tabular-nums"
            />
          )}
        </Field>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <ColumnField label="Title column" value={config.title_col ?? ''} onChange={(v) => onChange({ title_col: v })} placeholder="title" disabled={disabled} />
      <ColumnField label="Subtitle column" optional value={config.subtitle_col ?? ''} onChange={(v) => onChange({ subtitle_col: v || null })} disabled={disabled} />
      <ColumnField label="Badge column" optional value={config.badge_col ?? ''} onChange={(v) => onChange({ badge_col: v || null })} disabled={disabled} />
    </div>
  )
}
