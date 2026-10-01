import { ArrowClockwise, Copy, PencilSimple, PlusCircle, Robot, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { WidgetEditor } from '../components/widgets/WidgetEditor'
import { WidgetBody } from '../components/widgets/WidgetBody'
import { WidgetFrame } from '../components/widgets/WidgetFrame'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Dashboard, DashboardWidget } from '../lib/api-types'
import { AUTO_REFRESH_CHOICES, autoRefreshLabel, normalizeAutoRefresh } from '../lib/dashboard-refresh'
import { PageHeader } from '../components/ui/PageHeader'
import { ConfirmButton } from '../components/ui/ConfirmButton'

function renderWidgetBody(widget: DashboardWidget) {
  return <WidgetBody widget={widget} />
}

/** One dashboard's grid: view mode by default, "Edit" toggles add/edit/
 * delete/reorder controls. Refresh (dashboard-level or per-widget) always
 * re-executes the real stored SQL — see `agent_harness.repos.dashboards`.
 * A widget that errors (bad query, shape mismatch, timeout) renders its
 * error in place; every other widget still renders normally
 * (`WidgetFrame` never lets one widget's failure affect its siblings). */
export function DashboardPage() {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const navigate = useNavigate()
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingWidgets, setRefreshingWidgets] = useState<Set<string>>(new Set())
  const [editMode, setEditMode] = useState(false)
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | 'new' | null>(null)
  const [autoSeconds, setAutoSeconds] = useState(0)
  const [lastClientRefresh, setLastClientRefresh] = useState<string | null>(null)

  const { me } = useMe()
  const canWrite = canWriteResource(me, dashboard)
  const writeTitle = canWrite ? undefined : disabledReason(me, 'mutate_artifacts')

  const load = useCallback(() => {
    if (!dashboardId) return
    setError(null)
    api
      .getDashboard(dashboardId)
      .then((d) => {
        setDashboard(d)
        setAutoSeconds(normalizeAutoRefresh(d.auto_refresh_seconds))
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard.'))
  }, [dashboardId])

  useEffect(() => {
    setDashboard(null)
    load()
  }, [load])

  const handleRefreshAll = useCallback(async () => {
    if (!dashboardId) return
    setRefreshingAll(true)
    try {
      const updated = await api.refreshDashboard(dashboardId)
      setDashboard(updated)
      // Workaround for a known backend ordering bug (routers/dashboards.py
      // fetches the dashboard row *before* refresh_dashboard() bumps
      // last_refreshed_at, so the response still carries the pre-refresh
      // value): track the refresh client-side so the header is honest even
      // though the server's own timestamp is stale this call. See phase-08
      // report for the one-line backend fix.
      setLastClientRefresh(new Date().toISOString())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to refresh dashboard.')
    } finally {
      setRefreshingAll(false)
    }
  }, [dashboardId])

  const handleRefreshWidget = async (widgetId: string) => {
    if (!dashboardId) return
    setRefreshingWidgets((prev) => new Set(prev).add(widgetId))
    try {
      const updated = await api.refreshWidget(dashboardId, widgetId)
      setDashboard((d) => (d ? { ...d, widgets: d.widgets.map((w) => (w.id === widgetId ? updated : w)) } : d))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to refresh widget.')
    } finally {
      setRefreshingWidgets((prev) => {
        const next = new Set(prev)
        next.delete(widgetId)
        return next
      })
    }
  }

  const handleDeleteWidget = async (widget: DashboardWidget) => {
    if (!dashboardId) return
    try {
      await api.deleteWidget(dashboardId, widget.id)
      load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete widget.')
    }
  }

  const handleDeleteDashboard = async () => {
    if (!dashboardId || !dashboard) return
    try {
      await api.deleteDashboard(dashboardId)
      navigate('/dashboards')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete dashboard.')
    }
  }

  // Auto-refresh: the interval is saved on the dashboard (owner/admin) and
  // re-runs every widget's real query on a timer; a reader without write
  // access can still pick one for their own view (not persisted).
  useEffect(() => {
    if (autoSeconds === 0) return
    const id = setInterval(() => void handleRefreshAll(), autoSeconds * 1000)
    return () => clearInterval(id)
  }, [autoSeconds, handleRefreshAll])

  const changeAutoRefresh = async (seconds: number) => {
    setAutoSeconds(seconds)
    if (!dashboardId || !canWrite) return
    try {
      await api.updateDashboard(dashboardId, { auto_refresh_seconds: seconds })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the refresh interval.')
    }
  }

  const handleDuplicate = async () => {
    if (!dashboardId) return
    try {
      const copy = await api.duplicateDashboard(dashboardId)
      navigate(`/dashboards/${copy.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to duplicate dashboard.')
    }
  }

  if (error && !dashboard) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBanner message={error} onRetry={load} />
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-6xl">
        <Skeleton className="h-8 w-64" />
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-12">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl md:col-span-6" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/dashboards', label: 'All dashboards' }}
        title={dashboard.name}
        description={dashboard.description || undefined}
        meta={
          <>
          {dashboard.created_by_run_id && (
<Link
                to={`/runs/${dashboard.created_by_run_id}`}
                className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
              >
                <Robot size={11} weight="bold" />
                Built by the agent — view the run
              </Link>
          )}
          <span>{dashboard.last_refreshed_at || lastClientRefresh
              ? `Last refreshed ${new Date(dashboard.last_refreshed_at ?? lastClientRefresh!).toLocaleString()}`
              : 'Never refreshed'}</span>
          </>
        }
        actions={
          <>
            <select
            value={autoSeconds}
            onChange={(e) => void changeAutoRefresh(Number(e.target.value))}
            name="auto-refresh"
            className="ui-input"
            aria-label="Auto-refresh interval"
          >
            {AUTO_REFRESH_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>
                Auto-refresh: {seconds === 0 ? 'off' : autoRefreshLabel(seconds).replace('Every ', '')}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleRefreshAll()}
            disabled={refreshingAll}
            className="ui-btn ui-btn-secondary"
          >
            <ArrowClockwise size={14} weight="bold" className={refreshingAll ? 'animate-spin' : ''} />
            {refreshingAll ? 'Refreshing…' : 'Refresh all'}
          </button>
          <button
            type="button"
            onClick={() => void handleDuplicate()}
            disabled={me ? !me.permissions.includes('mutate_artifacts') : false}
            title="Copy this dashboard (widgets, queries, layout) into a new private one"
            className="ui-btn ui-btn-secondary"
          >
            <Copy size={14} weight="bold" />
            Duplicate
          </button>
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            disabled={!canWrite}
            title={writeTitle}
            aria-pressed={editMode}
            className={`ui-btn ${editMode ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
          >
            <PencilSimple size={14} weight="bold" />
            {editMode ? 'Done editing' : 'Edit'}
          </button>
          {editMode && canWrite && (
            <>
              <button
                type="button"
                onClick={() => setEditingWidget('new')}
                className="ui-btn ui-btn-primary"
              >
                <PlusCircle size={14} weight="bold" />
                Add widget
              </button>
              <ConfirmButton
                prompt={`Delete dashboard "${dashboard.name}"? This cannot be undone.`}
                onConfirm={() => void handleDeleteDashboard()}
                className="ui-btn ui-btn-danger"
              >
                <Trash size={13} weight="bold" />
                Delete dashboard
              </ConfirmButton>
            </>
          )}
          </>
        }
      />

      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {dashboard.widgets.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center text-sm text-zinc-500">
          No widgets yet.{' '}
          <button type="button" onClick={() => setEditingWidget('new')} className="font-medium text-sky-600 hover:underline">
            Add one
          </button>
          .
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-12">
          {dashboard.widgets.map((widget) => (
            <WidgetFrame
              key={widget.id}
              widget={widget}
              editMode={editMode}
              refreshing={refreshingWidgets.has(widget.id)}
              onRefresh={() => void handleRefreshWidget(widget.id)}
              onEdit={() => setEditingWidget(widget)}
              onDelete={() => void handleDeleteWidget(widget)}
            >
              {renderWidgetBody(widget)}
            </WidgetFrame>
          ))}
        </div>
      )}

      {editingWidget && (
        <WidgetEditor
          dashboardId={dashboard.id}
          widget={editingWidget === 'new' ? null : editingWidget}
          onClose={() => setEditingWidget(null)}
          onSaved={() => {
            setEditingWidget(null)
            load()
          }}
        />
      )}
    </div>
  )
}
