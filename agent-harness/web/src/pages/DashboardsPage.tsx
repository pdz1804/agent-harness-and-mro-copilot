import { ChartBar, Copy, PlusCircle, Robot } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { VisibilityBadge } from '../components/ui/VisibilityBadge'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import { autoRefreshLabel } from '../lib/dashboard-refresh'
import { getCurrentUserId } from '../lib/identity'
import type { Dashboard, DashboardTemplate } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

/** Dashboards (phase 06): a list of the caller's readable dashboards plus a
 * "New from template" gallery. Every template instantiation copies real
 * widget rows the user can then edit/delete/add to freely (the template
 * itself is never referenced again). */
export function DashboardsPage() {
  const navigate = useNavigate()
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null)
  const [templates, setTemplates] = useState<DashboardTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [creating, setCreating] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([api.listDashboards(), api.listDashboardTemplates()])
      .then(([d, t]) => {
        if (cancelled) return
        setDashboards(d)
        setTemplates(t)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load dashboards.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const handleCreate = async (templateKey: string, name: string) => {
    setCreating(templateKey)
    setCreateError(null)
    try {
      const dashboard = await api.createDashboard({ name, template_key: templateKey })
      navigate(`/dashboards/${dashboard.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create dashboard.')
      setCreating(null)
    }
  }

  const currentUserId = getCurrentUserId()
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_artifacts') : true

  const handleDuplicate = async (dashboard: Dashboard) => {
    setCreateError(null)
    try {
      const copy = await api.duplicateDashboard(dashboard.id)
      navigate(`/dashboards/${copy.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to duplicate dashboard.')
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Dashboards"
        description={<>Stats, charts, and tables backed by stored read-only SQL — every value comes from a
            live query, and "Refresh" always re-runs it. Or ask the agent in chat — e.g.{' '}
            <Link to="/chat" className="font-medium text-sky-700 hover:text-sky-800">
              "build me a dashboard of incidents by severity over time"
            </Link>{' '}
            — and approve what it proposes.</>}
      />

      {createError && (
        <div className="mt-4">
          <ErrorBanner message={createError} />
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-xs font-semibold text-zinc-500 ">
          New from template
        </h2>
        {!error && templates === null ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {templates?.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={creating !== null}
                onClick={() => void handleCreate(t.key, t.name)}
                className="ui-card flex flex-col items-start gap-2 p-4 text-left transition hover:border-sky-300 hover:shadow-sm disabled:opacity-60"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700">
                  <ChartBar size={14} weight="bold" />
                </span>
                <p className="text-sm font-semibold text-zinc-900">{t.name}</p>
                <p className="line-clamp-2 text-xs text-zinc-500">{t.description}</p>
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  {t.widget_kinds.map((k) => (
                    <span key={k} className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
                      {k}
                    </span>
                  ))}
                </div>
                {creating === t.key && <p className="text-xs text-sky-600">Creating…</p>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-8">
        <h2 className="mb-2 text-xs font-semibold text-zinc-500 ">Your dashboards</h2>
        {error && <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />}
        {!error && dashboards === null ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : dashboards && dashboards.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.map((d) => (
              <div key={d.id} className="ui-card flex flex-col transition hover:border-sky-300 hover:shadow-sm">
                <button
                  type="button"
                  onClick={() => navigate(`/dashboards/${d.id}`)}
                  className="flex flex-1 flex-col items-start gap-1.5 p-4 text-left"
                >
                  <div className="flex w-full items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-zinc-900">{d.name}</p>
                    <VisibilityBadge visibility={d.visibility} />
                  </div>
                  <p className="text-xs text-zinc-500">
                    {d.widgets.length} widget{d.widgets.length === 1 ? '' : 's'} · {d.template_key}
                    {d.auto_refresh_seconds ? ` · ${autoRefreshLabel(d.auto_refresh_seconds).toLowerCase()}` : ''}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {d.owner_id === currentUserId ? 'You' : d.owner_id}
                    {d.last_refreshed_at ? ` · last refreshed ${new Date(d.last_refreshed_at).toLocaleString()}` : ''}
                  </p>
                </button>
                <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-1.5 text-xs">
                  {d.created_by_run_id ? (
                    <Link
                      to={`/runs/${d.created_by_run_id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-800 hover:bg-sky-100"
                      title="Created by the agent in this run"
                    >
                      <Robot size={11} weight="bold" />
                      Built by agent
                    </Link>
                  ) : (
                    <span className="text-zinc-500">Manual</span>
                  )}
                  <button
                    type="button"
                    disabled={!canMutate}
                    title={canMutate ? 'Copy this dashboard into a new private one' : disabledReason(me, 'mutate_artifacts')}
                    onClick={() => void handleDuplicate(d)}
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Copy size={11} weight="bold" />
                    Duplicate
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          !error && (
            <EmptyState
              icon={<PlusCircle size={28} />}
              title="No dashboards yet"
              description="Pick a template above to create your first dashboard."
            />
          )
        )}
      </div>
    </div>
  )
}
