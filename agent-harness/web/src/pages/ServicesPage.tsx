import { ArrowClockwise, Pulse } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { disabledReason, useLacksPermission, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Service, ServiceStatus } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

const STATUS_STYLES: Record<ServiceStatus, string> = {
  operational: 'bg-emerald-50 text-emerald-700',
  degraded: 'bg-amber-50 text-amber-700',
  down: 'bg-rose-50 text-rose-700',
}

const STATUS_OPTIONS: ServiceStatus[] = ['operational', 'degraded', 'down']

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function ServicesPage() {
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const { me } = useMe()
  const cannotMutate = useLacksPermission('mutate_services')

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .listServices()
      .then((data) => {
        if (!cancelled) setServices(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load services.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const handleStatusChange = async (name: string, status: ServiceStatus) => {
    setUpdating(name)
    try {
      const updated = await api.setServiceStatus(name, status)
      setServices((prev) => (prev ? prev.map((s) => (s.name === name ? updated : s)) : prev))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update service status.')
    } finally {
      setUpdating(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Services"
        description={<>Mock service registry, persisted in PostgreSQL. Flip a status to create a real scenario for the
            agent to investigate on the New run page.</>}
        actions={<><button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          className="ui-btn ui-btn-secondary"
        >
          <ArrowClockwise size={14} weight="bold" />
          Refresh
        </button></>}
      />

      <div className="mt-4">
        {error && <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />}

        {!error && services === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : services && services.length > 0 ? (
          <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
            {services.map((svc) => (
              <li key={svc.name} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Pulse size={14} className="text-zinc-500" />
                    <span className="font-data text-sm text-zinc-900">{svc.name}</span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[svc.status]}`}
                    >
                      {svc.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {svc.owner ?? 'unowned'} · latency {svc.latency_ms ?? '—'}ms · error rate{' '}
                    {svc.error_rate !== null ? `${(svc.error_rate * 100).toFixed(2)}%` : '—'} · last
                    checked {formatTimestamp(svc.last_checked)}
                  </p>
                </div>
                <select name="select"
                  value={svc.status}
                  disabled={updating === svc.name || cannotMutate}
                  title={cannotMutate ? disabledReason(me, 'mutate_services') : undefined}
                  onChange={(e) => void handleStatusChange(svc.name, e.target.value as ServiceStatus)}
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:opacity-50"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        ) : (
          !error && <p className="text-sm text-zinc-500">No services in the registry.</p>
        )}
      </div>
    </div>
  )
}
