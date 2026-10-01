import { ArrowClockwise, Plug } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { ToolDetail } from '../components/integrations/ToolDetail'
import { PageHeader } from '../components/ui/PageHeader'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Integration } from '../lib/api-types'

/** Integrations: per-tool on/off toggles plus a detail panel per tool (schema,
 * stats, recent calls, timeout/retry overrides). A disabled tool is genuinely
 * removed from the tool list the agent is built with for the *next* run, and
 * limits likewise apply to new runs only; see
 * `agent_harness.run_registry.RunRegistry._build_enabled_tool_registry`.
 * The open tool lives in `?tool=<name>` so a detail view is linkable. */
export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [params, setParams] = useSearchParams()
  const selected = params.get('tool')
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_integrations') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_integrations')

  useEffect(() => {
    let cancelled = false
    api
      .listIntegrations()
      .then((data) => {
        if (!cancelled) setIntegrations(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load integrations.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const replaceIntegration = (updated: Integration) =>
    setIntegrations((prev) => (prev ? prev.map((i) => (i.tool_name === updated.tool_name ? updated : i)) : prev))

  const handleToggle = async (toolName: string, enabled: boolean) => {
    setUpdating(toolName)
    try {
      replaceIntegration(await api.setIntegrationEnabled(toolName, enabled))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update integration.')
    } finally {
      setUpdating(null)
    }
  }

  const select = (toolName: string) => setParams({ tool: toolName }, { replace: true })
  const retry = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Integrations"
        description="Turn tools on or off and tune their timeout and retries. Changes apply to runs started after you save; a disabled tool is removed from what the agent can call, not just hidden here."
        actions={
          <button type="button" onClick={retry} className="ui-btn ui-btn-secondary">
            <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
            Refresh
          </button>
        }
      />

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {!error && integrations === null ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : integrations && integrations.length > 0 ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden" aria-label="Tools">
            {integrations.map((integration) => {
              const isSelected = selected === integration.tool_name
              const overridden = integration.timeout_seconds !== null || integration.max_retries !== null
              return (
                <li
                  key={integration.tool_name}
                  className={`flex items-center gap-2 pr-4 ${isSelected ? 'bg-sky-50' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => select(integration.tool_name)}
                    aria-current={isSelected ? 'true' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 py-3 pl-4 text-left"
                  >
                    <Plug size={14} className="shrink-0 text-zinc-600" aria-hidden="true" />
                    <span className="font-data min-w-0 truncate text-[13px] font-medium text-zinc-900">
                      {integration.tool_name}
                    </span>
                    {!integration.enabled && <span className="text-xs text-zinc-600">Off</span>}
                    {overridden && (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 ring-1 ring-zinc-300 ring-inset">
                        Custom limits
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={integration.enabled}
                    aria-label={`${integration.enabled ? 'Disable' : 'Enable'} ${integration.tool_name}`}
                    disabled={!canMutate || updating === integration.tool_name}
                    title={mutateTitle}
                    onClick={() => void handleToggle(integration.tool_name, !integration.enabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      integration.enabled ? 'bg-sky-600' : 'bg-zinc-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white transition-transform ${
                        integration.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="min-w-0">
            {selected ? (
              <ToolDetail key={selected} tool={selected} refreshToken={refreshToken} onLimitsSaved={replaceIntegration} />
            ) : (
              <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-[13px] text-zinc-600">
                Select a tool to see its schema, recent calls, error rate and latency.
              </p>
            )}
          </div>
        </div>
      ) : (
        !error && (
          <EmptyState
            icon={<Plug size={28} aria-hidden="true" />}
            title="No integrations configured"
            description="Tools appear here once the harness registers them. Check that the backend started cleanly, then refresh."
          />
        )
      )}
    </div>
  )
}
