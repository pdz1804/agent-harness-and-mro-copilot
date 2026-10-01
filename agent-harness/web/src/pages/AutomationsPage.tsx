import { ArrowClockwise, Lightning, PlusCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Automation, AutomationTriggeredRun, Service, ServiceStatus } from '../lib/api-types'
import { PageHeader } from '../components/ui/PageHeader'

const STATUS_OPTIONS: ServiceStatus[] = ['operational', 'degraded', 'down']

function formatEpoch(value: number): string {
  return new Date(value * 1000).toLocaleString()
}

/** Automations tab (12d): a real, event-driven rule engine. When a
 * service's status is flipped via the Services page (`POST
 * /services/{name}/status`), the backend checks every enabled automation
 * matching that exact service+status transition and, for each match, starts
 * a real new run with the automation's objective — the same
 * `RunRegistry.start_run` code path a manual "New run" submission uses (see
 * `api.py::_trigger_automations`), not a simulated/logged-only trigger. */
export function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [triggeredRuns, setTriggeredRuns] = useState<AutomationTriggeredRun[] | null>(null)
  const [services, setServices] = useState<Service[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const [newName, setNewName] = useState('')
  const [newServiceName, setNewServiceName] = useState('any')
  const [newStatus, setNewStatus] = useState<ServiceStatus>('down')
  const [newObjective, setNewObjective] = useState('')
  const [creating, setCreating] = useState(false)

  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_automations') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_automations')

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([api.listAutomations(), api.listAutomationRuns(), api.listServices()])
      .then(([a, r, s]) => {
        if (cancelled) return
        setAutomations(a)
        setTriggeredRuns(r)
        setServices(s)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load automations.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const handleToggle = async (automationId: string, enabled: boolean) => {
    setUpdating(automationId)
    try {
      const updated = await api.setAutomationEnabled(automationId, enabled)
      setAutomations((prev) => (prev ? prev.map((a) => (a.id === automationId ? updated : a)) : prev))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update automation.')
    } finally {
      setUpdating(null)
    }
  }

  const handleCreate = async () => {
    if (!newName.trim() || !newObjective.trim()) return
    setCreating(true)
    try {
      await api.createAutomation({
        name: newName.trim(),
        trigger_service_name: newServiceName,
        trigger_status: newStatus,
        objective_template: newObjective.trim(),
      })
      setNewName('')
      setNewObjective('')
      setRefreshToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create automation.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Automations"
        description={<>Real, event-driven rules: when a service flips to a matching status on the{' '}
            <Link to="/services" className="text-sky-600 hover:underline">
              Services
            </Link>{' '}
            page, a real new run starts with the configured objective.</>}
        actions={<><button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          className="ui-btn ui-btn-secondary"
        >
          <ArrowClockwise size={14} weight="bold" />
          Refresh
        </button></>}
      />

      <div className="mt-4 ui-card p-4">
        <label htmlFor="new-automation-name" className="mb-1.5 block text-xs font-medium text-zinc-500">
          New automation
        </label>
        <input name="new-automation-name" autoComplete="off"
          id="new-automation-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name (e.g. Investigate search-index outages)…"
          disabled={!canMutate}
          className="mb-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-500"
        />
        <div className="mb-2 flex gap-2">
          <select name="select"
            value={newServiceName}
            onChange={(e) => setNewServiceName(e.target.value)}
            className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          >
            <option value="any">any service</option>
            {(services ?? []).map((svc) => (
              <option key={svc.name} value={svc.name}>
                {svc.name}
              </option>
            ))}
          </select>
          <span className="flex items-center text-xs text-zinc-500">flips to</span>
          <select name="select"
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value as ServiceStatus)}
            className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-800 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <textarea name="textarea" autoComplete="off"
          value={newObjective}
          onChange={(e) => setNewObjective(e.target.value)}
          rows={2}
          placeholder="Objective to start a run with, e.g. 'investigate search-index'…"
          disabled={!canMutate}
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-500"
        />
        <button
          type="button"
          disabled={!canMutate || creating || !newName.trim() || !newObjective.trim()}
          title={mutateTitle}
          onClick={() => void handleCreate()}
          className="ui-btn ui-btn-primary ui-btn-sm mt-2"
        >
          <PlusCircle size={14} weight="bold" />
          {creating ? 'Creating…' : 'Create automation'}
        </button>
      </div>

      <div className="mt-4">
        {error && <ErrorBanner message={error} onRetry={() => setRefreshToken((n) => n + 1)} />}

        {!error && automations === null ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : automations && automations.length > 0 ? (
          <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
            {automations.map((automation) => (
              <li key={automation.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Lightning size={14} className="text-zinc-500" />
                    <span className="text-sm font-medium text-zinc-900">{automation.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    when <span className="font-data">{automation.trigger_service_name}</span> flips to{' '}
                    <span className="font-data">{automation.trigger_status}</span> — run:{' '}
                    <span className="font-data">{automation.objective_template}</span>
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={automation.enabled}
                  disabled={!canMutate || updating === automation.id}
                  title={mutateTitle}
                  onClick={() => void handleToggle(automation.id, !automation.enabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${
                    automation.enabled ? 'bg-sky-600' : 'bg-zinc-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition ${
                      automation.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          !error && <p className="text-sm text-zinc-500">No automations configured.</p>
        )}
      </div>

      <h2 className="mt-6 text-sm font-semibold text-zinc-900">Recent automation-triggered runs</h2>
      <div className="mt-2">
        {!error && triggeredRuns === null ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : triggeredRuns && triggeredRuns.length > 0 ? (
          <ul className="space-y-2">
            {triggeredRuns.map((run) => (
              <li key={run.run_id} className="ui-card p-3 text-sm">
                <Link to={`/runs/${run.run_id}`} className="font-medium text-sky-700 hover:underline">
                  {run.objective}
                </Link>
                <p className="mt-0.5 text-xs text-zinc-500">
                  run <span className="font-data">{run.run_id}</span> · status{' '}
                  <span className="font-data">{run.status}</span> · {formatEpoch(run.started_at)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          !error && <p className="text-sm text-zinc-500">No automation-triggered runs yet.</p>
        )}
      </div>
    </div>
  )
}
