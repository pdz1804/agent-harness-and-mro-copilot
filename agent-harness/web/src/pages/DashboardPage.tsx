import { ArrowClockwise, ArrowDown, ArrowUp, ChartBar, Copy, Lock, PencilSimple, Plus, Robot, ShareNetwork, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { WidgetBody } from '../components/widgets/WidgetBody'
import { WidgetEditor } from '../components/widgets/WidgetEditor'
import { WidgetFrame } from '../components/widgets/WidgetFrame'
import {
  Button,
  CardGridSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  PageHeader,
  RelativeTime,
  RowActions,
  Select,
  Skeleton,
  useToast,
  type RowAction,
} from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import type { Dashboard, DashboardWidget } from '../lib/api-types'
import { AUTO_REFRESH_CHOICES, autoRefreshLabel, normalizeAutoRefresh } from '../lib/dashboard-refresh'
import { moveId } from '../lib/dashboards-model'
import { UNDO_WINDOW_MS, deferAction } from '../lib/deferred-action'

function withoutId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  next.delete(id)
  return next
}

/** One dashboard's grid. Refresh (dashboard-level or per-widget) always
 * re-executes the real stored SQL. A widget that errors (bad query, shape
 * mismatch, timeout) renders its error in place; every other widget still
 * renders (`WidgetFrame` never lets one failure affect its siblings). The
 * widget editor is a sheet deep-linked with `?widget=<id>` (`?widget=new`
 * adds one). Widget deletes have no server-side restore, so they are
 * optimistic and held for the Undo window (`deferAction`). */
export function DashboardPage() {
  const { dashboardId } = useParams<{ dashboardId: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const [widgetParam, setWidgetParam] = useUrlState('widget')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingWidgets, setRefreshingWidgets] = useState<Set<string>>(() => new Set())
  const [hiddenWidgets, setHiddenWidgets] = useState<Set<string>>(() => new Set())
  const [autoSeconds, setAutoSeconds] = useState(0)
  const [lastClientRefresh, setLastClientRefresh] = useState<string | null>(null)

  const { me } = useMe()
  const hasMutatePermission = me ? me.permissions.includes('mutate_artifacts') : true
  const canWrite = hasMutatePermission && canWriteResource(me, dashboard)
  const writeReason = hasMutatePermission ? 'Only the owner or an admin can edit this dashboard.' : disabledReason(me, 'mutate_artifacts')
  const writeTitle = canWrite ? undefined : writeReason
  useDocumentTitle(dashboard?.name ?? null)

  const load = useCallback(() => {
    if (!dashboardId) return
    setError(null)
    api.getDashboard(dashboardId).then(
      (d) => {
        setDashboard(d)
        setAutoSeconds(normalizeAutoRefresh(d.auto_refresh_seconds))
      },
      (err: unknown) => setError(errorText(err, 'Could not load this dashboard.')),
    )
  }, [dashboardId])

  useEffect(() => {
    setDashboard(null)
    setLastClientRefresh(null)
    load()
  }, [load])

  const visibleWidgets = useMemo(() => (dashboard ? dashboard.widgets.filter((w) => !hiddenWidgets.has(w.id)) : []), [dashboard, hiddenWidgets])

  const handleRefreshAll = useCallback(
    async (manual: boolean) => {
      if (!dashboardId) return
      setRefreshingAll(true)
      try {
        const updated = await api.refreshDashboard(dashboardId)
        setDashboard(updated)
        // The refresh response still carries the pre-refresh `last_refreshed_at`
        // (the router reads the row before the refresh bumps it), so the header
        // tracks the refresh client-side to stay honest.
        setLastClientRefresh(new Date().toISOString())
        if (manual) {
          const failing = updated.widgets.filter((w) => w.last_error).length
          toast({
            title: 'Dashboard refreshed',
            description: `${updated.widgets.length} widget${updated.widgets.length === 1 ? '' : 's'}${failing ? ` · ${failing} with an error` : ''}`,
          })
        }
      } catch (err) {
        toast({ tone: 'error', title: "Couldn't refresh the dashboard", description: errorText(err, 'Try again.') })
      } finally {
        setRefreshingAll(false)
      }
    },
    [dashboardId, toast],
  )

  const handleRefreshWidget = async (widget: DashboardWidget) => {
    if (!dashboardId) return
    setRefreshingWidgets((prev) => new Set(prev).add(widget.id))
    try {
      const updated = await api.refreshWidget(dashboardId, widget.id)
      setDashboard((d) => (d ? { ...d, widgets: d.widgets.map((w) => (w.id === widget.id ? updated : w)) } : d))
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't refresh “${widget.title}”`, description: errorText(err, 'Try again.') })
    } finally {
      setRefreshingWidgets((prev) => withoutId(prev, widget.id))
    }
  }

  /** Optimistic removal; the request is held for the Undo window. */
  const deleteWidget = (widget: DashboardWidget) => {
    if (!dashboardId) return
    setHiddenWidgets((prev) => new Set(prev).add(widget.id))
    if (widgetParam === widget.id) setWidgetParam('')
    const cancel = deferAction(
      `widget-delete:${widget.id}`,
      async () => {
        await api.deleteWidget(dashboardId, widget.id)
        setDashboard((d) => (d ? { ...d, widgets: d.widgets.filter((w) => w.id !== widget.id) } : d))
        setHiddenWidgets((prev) => withoutId(prev, widget.id))
      },
      UNDO_WINDOW_MS,
      (err) => {
        setHiddenWidgets((prev) => withoutId(prev, widget.id))
        toast({ tone: 'error', title: `Couldn't delete “${widget.title}”`, description: errorText(err, 'It is back on the dashboard.') })
      },
    )
    toast({
      title: `Deleted “${widget.title}”`,
      duration: UNDO_WINDOW_MS - 500,
      action: {
        label: 'Undo',
        run: () => {
          if (!cancel()) throw new Error('It was already saved')
          setHiddenWidgets((prev) => withoutId(prev, widget.id))
        },
      },
    })
  }

  /** Move a widget one place and persist the whole order. */
  const moveWidget = async (widget: DashboardWidget, delta: -1 | 1) => {
    if (!dashboardId || !dashboard) return
    const before = visibleWidgets.map((w) => w.id)
    const after = moveId(before, widget.id, delta)
    if (after === before) return
    const apply = async (ids: string[]) => {
      // Widgets held for deletion keep their relative place at the end.
      const hidden = dashboard.widgets.filter((w) => hiddenWidgets.has(w.id)).map((w) => w.id)
      const updated = await api.reorderWidgets(dashboardId, [...ids, ...hidden])
      setDashboard((d) => (d ? { ...d, widgets: updated.widgets } : d))
    }
    const byId = new Map(dashboard.widgets.map((w) => [w.id, w]))
    // Optimistic: show the new order while the request is in flight.
    setDashboard((d) => (d ? { ...d, widgets: [...after.map((id) => byId.get(id)!), ...d.widgets.filter((w) => hiddenWidgets.has(w.id))] } : d))
    try {
      await apply(after)
      toast({
        title: `Moved “${widget.title}” ${delta < 0 ? 'earlier' : 'later'}`,
        action: { label: 'Undo', run: () => apply(before) },
      })
    } catch (err) {
      setDashboard((d) => (d ? { ...d, widgets: [...before.map((id) => byId.get(id)!), ...d.widgets.filter((w) => hiddenWidgets.has(w.id))] } : d))
      toast({ tone: 'error', title: `Couldn't move “${widget.title}”`, description: errorText(err, 'Try again.') })
    }
  }

  const deleteDashboard = async () => {
    if (!dashboardId || !dashboard) return
    const { id, name } = dashboard
    try {
      await api.deleteDashboard(id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${name}”`, description: errorText(err, 'Try again.') })
      return
    }
    navigate('/dashboards')
    toast({
      title: `Deleted “${name}”`,
      description: 'Kept in the trash for 7 days.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreDashboard(id)
          toast({ title: `Restored “${name}”`, action: { label: 'Open', run: () => navigate(`/dashboards/${id}`) } })
        },
      },
    })
  }

  const duplicate = async () => {
    if (!dashboardId || !dashboard) return
    try {
      const copy = await api.duplicateDashboard(dashboardId)
      toast({ title: `Duplicated as “${copy.name}”`, action: { label: 'Open', run: () => navigate(`/dashboards/${copy.id}`) } })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't duplicate “${dashboard.name}”`, description: errorText(err, 'Try again.') })
    }
  }

  // Auto-refresh: the interval is saved on the dashboard (owner/admin) and
  // re-runs every widget's real query on a timer; a reader without write
  // access can still pick one for their own view (not persisted).
  useEffect(() => {
    if (autoSeconds === 0) return
    const id = setInterval(() => void handleRefreshAll(false), autoSeconds * 1000)
    return () => clearInterval(id)
  }, [autoSeconds, handleRefreshAll])

  const changeAutoRefresh = async (seconds: number) => {
    const previous = autoSeconds
    setAutoSeconds(seconds)
    if (!dashboardId || !canWrite) return
    const save = (value: number) => api.updateDashboard(dashboardId, { auto_refresh_seconds: value })
    try {
      await save(seconds)
      toast({
        title: seconds === 0 ? 'Auto-refresh turned off' : `Auto-refresh ${autoRefreshLabel(seconds).toLowerCase()}`,
        action: {
          label: 'Undo',
          run: async () => {
            await save(previous)
            setAutoSeconds(previous)
          },
        },
      })
    } catch (err) {
      setAutoSeconds(previous)
      toast({ tone: 'error', title: "Couldn't save the refresh interval", description: errorText(err, 'Try again.') })
    }
  }

  const openWidget = widgetParam && widgetParam !== 'new' ? (visibleWidgets.find((w) => w.id === widgetParam) ?? null) : null
  const openIndex = openWidget ? visibleWidgets.findIndex((w) => w.id === openWidget.id) : -1
  const stepWidget = (delta: 1 | -1) => {
    if (visibleWidgets.length < 2 || openIndex < 0) return
    setWidgetParam(visibleWidgets[(openIndex + delta + visibleWidgets.length) % visibleWidgets.length].id)
  }

  // A deep link to a widget that no longer exists drops the parameter.
  useEffect(() => {
    if (dashboard && widgetParam && widgetParam !== 'new' && !visibleWidgets.some((w) => w.id === widgetParam)) setWidgetParam('')
  }, [dashboard, visibleWidgets, widgetParam, setWidgetParam])

  const widgetActions = (widget: DashboardWidget, index: number): RowAction[] => [
    { label: canWrite ? 'Edit widget' : 'View widget', icon: <PencilSimple size={14} />, onSelect: () => setWidgetParam(widget.id) },
    { label: 'Refresh now', icon: <ArrowClockwise size={14} />, onSelect: () => handleRefreshWidget(widget) },
    {
      label: 'Move earlier',
      icon: <ArrowUp size={14} />,
      disabled: !canWrite || index === 0,
      disabledReason: !canWrite ? writeReason : 'Already first.',
      onSelect: () => moveWidget(widget, -1),
    },
    {
      label: 'Move later',
      icon: <ArrowDown size={14} />,
      disabled: !canWrite || index === visibleWidgets.length - 1,
      disabledReason: !canWrite ? writeReason : 'Already last.',
      onSelect: () => moveWidget(widget, 1),
    },
    {
      label: 'Delete widget',
      icon: <Trash size={14} />,
      destructive: true,
      disabled: !canWrite,
      disabledReason: writeReason,
      confirm: { title: `Delete widget “${widget.title}”?`, description: 'You can undo for a few seconds.', confirmLabel: 'Delete widget' },
      onSelect: () => deleteWidget(widget),
    },
  ]

  if (error && !dashboard) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Dashboard" back={{ to: '/dashboards', label: 'All dashboards' }} />
        <ErrorState message={error} onRetry={load} />
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title={<Skeleton className="mt-1 h-7 w-64" />} back={{ to: '/dashboards', label: 'All dashboards' }} />
        <CardGridSkeleton count={4} className="grid grid-cols-1 gap-4 md:grid-cols-2" />
      </div>
    )
  }

  const refreshedAt = lastClientRefresh ?? dashboard.last_refreshed_at
  const editorWidget = widgetParam === 'new' ? null : openWidget

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/dashboards', label: 'All dashboards' }}
        title={dashboard.name}
        description={dashboard.description || undefined}
        meta={
          <>
            <Chip icon={dashboard.visibility === 'private' ? <Lock size={11} /> : <ShareNetwork size={11} />}>{dashboard.visibility === 'private' ? 'Private' : 'Shared'}</Chip>
            <Chip>{`${visibleWidgets.length} widget${visibleWidgets.length === 1 ? '' : 's'}`}</Chip>
            {dashboard.created_by_run_id && (
              <Link to={`/runs/${dashboard.created_by_run_id}`} title="Created by the agent in this run" className="rounded-full">
                <Chip tone="iris" icon={<Robot size={11} weight="bold" />}>
                  Built by agent
                </Chip>
              </Link>
            )}
            <span>
              {refreshedAt ? (
                <>
                  Updated <RelativeTime value={refreshedAt} />
                </>
              ) : (
                'Never refreshed'
              )}
            </span>
          </>
        }
        actions={
          <>
            <Select
              value={autoSeconds}
              onChange={(e) => void changeAutoRefresh(Number(e.target.value))}
              name="auto-refresh"
              aria-label="Auto-refresh interval"
              title={canWrite ? 'Saved on the dashboard' : 'Applies to your view only'}
            >
              {AUTO_REFRESH_CHOICES.map((seconds) => (
                <option key={seconds} value={seconds}>
                  Auto-refresh: {seconds === 0 ? 'off' : autoRefreshLabel(seconds).replace('Every ', '')}
                </option>
              ))}
            </Select>
            <Button icon={<ArrowClockwise size={14} weight="bold" />} loading={refreshingAll} onClick={() => void handleRefreshAll(true)} title="Re-run every widget's query">
              Refresh all
            </Button>
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} disabled={!canWrite} title={writeTitle} onClick={() => setWidgetParam('new')}>
              Add widget
            </Button>
            <RowActions
              visibility="always"
              label={`More actions for “${dashboard.name}”`}
              items={[
                {
                  label: 'Duplicate',
                  icon: <Copy size={14} />,
                  disabled: !hasMutatePermission,
                  disabledReason: disabledReason(me, 'mutate_artifacts'),
                  onSelect: duplicate,
                },
                {
                  label: 'Delete dashboard',
                  icon: <Trash size={14} />,
                  destructive: true,
                  disabled: !canWrite,
                  disabledReason: writeReason,
                  confirm: { title: `Delete “${dashboard.name}”?`, description: 'Its widgets go with it. You can undo for a few seconds.', confirmLabel: 'Delete dashboard' },
                  onSelect: deleteDashboard,
                },
              ]}
            />
          </>
        }
      />

      {error && <p className="mb-3 text-xs text-rose-700">{error}</p>}

      {visibleWidgets.length === 0 ? (
        <EmptyState
          icon={<ChartBar size={22} weight="duotone" />}
          title="No widgets yet"
          description="Each widget runs a stored read-only query and shows the result as a number, chart, table or list."
          action={
            <Button icon={<Plus size={14} weight="bold" />} disabled={!canWrite} title={writeTitle} onClick={() => setWidgetParam('new')}>
              Add widget
            </Button>
          }
          example="Try: SELECT status, count(*) AS n FROM services GROUP BY status"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {visibleWidgets.map((widget, index) => (
            <WidgetFrame
              key={widget.id}
              widget={widget}
              selected={openWidget?.id === widget.id}
              refreshing={refreshingWidgets.has(widget.id) || (refreshingAll && !widget.last_result)}
              onRefresh={() => void handleRefreshWidget(widget)}
              onOpen={() => setWidgetParam(widget.id)}
              actions={widgetActions(widget, index)}
            >
              <WidgetBody widget={widget} />
            </WidgetFrame>
          ))}
        </div>
      )}

      {(widgetParam === 'new' || openWidget) && (
        <WidgetEditor
          key={editorWidget?.id ?? 'new'}
          dashboardId={dashboard.id}
          dashboardName={dashboard.name}
          widget={editorWidget}
          position={openWidget ? { index: openIndex, total: visibleWidgets.length } : undefined}
          canWrite={canWrite}
          writeReason={writeReason}
          onClose={() => setWidgetParam('')}
          onPrev={openWidget && visibleWidgets.length > 1 ? () => stepWidget(-1) : undefined}
          onNext={openWidget && visibleWidgets.length > 1 ? () => stepWidget(1) : undefined}
          onDelete={deleteWidget}
          onSaved={(saved, previous) => {
            setWidgetParam('')
            load()
            toast({
              title: previous ? `Saved “${saved.title}”` : `Added “${saved.title}”`,
              action: {
                label: 'Undo',
                run: async () => {
                  if (previous) {
                    await api.updateWidget(dashboard.id, saved.id, {
                      title: previous.title,
                      sql_query: previous.sql_query,
                      config: previous.config,
                      col_span: previous.col_span,
                    })
                  } else {
                    await api.deleteWidget(dashboard.id, saved.id)
                  }
                  load()
                },
              },
            })
          }}
        />
      )}
    </div>
  )
}
