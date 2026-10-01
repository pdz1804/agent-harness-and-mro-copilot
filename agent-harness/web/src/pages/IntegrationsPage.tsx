import { Plug, ShieldCheck } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ToolDetail } from '../components/integrations/ToolDetail'
import { Button, Chip, EmptyState, ErrorState, FilteredEmpty, PageHeader, RelativeTime, Row, SearchInput, Segmented, Switch, Table, TableSkeleton, useToast } from '../components/ui'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { disabledReason, useMe } from '../hooks/useMe'
import { api, errorText } from '../lib/api'
import type { Integration } from '../lib/api-types'
import { ENABLED_FILTERS, filterIntegrations, hasCustomLimits, hasIntegrationFilters, limitsSummary, type EnabledFilter } from '../lib/integrations-filter'

const FILTER_KEYS = ['q', 'state']

/** Integrations: per-tool on/off switches plus a sheet per tool (schema, usage,
 * recent calls, timeout/retry overrides). A disabled tool is genuinely removed
 * from the tool list the agent is built with for the next run, and limits
 * likewise apply to new runs only (`RunRegistry._build_enabled_tool_registry`).
 * Search, the enabled filter and the open tool (`?open=<toolName>`) live in the
 * URL. Enabling or disabling toasts with an Undo that toggles back. */
export function IntegrationsPage() {
  const toast = useToast()
  const [q, setQ] = useUrlState('q')
  const [state, setState] = useUrlEnum<EnabledFilter>('state', ENABLED_FILTERS, 'all')
  const [openRaw, setOpen] = useUrlState('open')
  const [legacyTool] = useUrlState('tool')
  const openId = openRaw || legacyTool
  const clearParams = useClearUrlParams()
  const [integrations, setIntegrations] = useState<Integration[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<Set<string>>(() => new Set())
  const [refreshToken, setRefreshToken] = useState(0)
  const limitsDirty = useRef(false)
  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_integrations') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_integrations')

  useEffect(() => {
    let cancelled = false
    api.listIntegrations().then(
      (data) => {
        if (cancelled) return
        setIntegrations(data)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load integrations.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const replaceIntegration = useCallback((updated: Integration) => setIntegrations((prev) => (prev ? prev.map((i) => (i.tool_name === updated.tool_name ? updated : i)) : prev)), [])

  const setPending = (toolName: string, on: boolean) =>
    setUpdating((prev) => {
      const next = new Set(prev)
      if (on) next.add(toolName)
      else next.delete(toolName)
      return next
    })

  /** Flip a tool; the toast's Undo flips it back. */
  const toggle = async (toolName: string, enabled: boolean) => {
    setPending(toolName, true)
    try {
      replaceIntegration(await api.setIntegrationEnabled(toolName, enabled))
      toast({
        title: `${enabled ? 'Enabled' : 'Disabled'} ${toolName}`,
        description: 'Applies to runs started from now on.',
        action: {
          label: 'Undo',
          run: async () => {
            replaceIntegration(await api.setIntegrationEnabled(toolName, !enabled))
          },
        },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't ${enabled ? 'enable' : 'disable'} ${toolName}`, description: errorText(err, 'Try again.') })
    } finally {
      setPending(toolName, false)
    }
  }

  const filters = { q, state }
  const active = hasIntegrationFilters(filters)
  const rows = useMemo(() => (integrations ? filterIntegrations(integrations, { q, state }) : null), [integrations, q, state])
  const setLimitsDirty = useCallback((dirty: boolean) => {
    limitsDirty.current = dirty
  }, [])
  const retry = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }
  const clearFilters = () => clearParams(FILTER_KEYS)

  /** Switching tools with unsaved limits would drop them silently: refuse and say why. */
  const openTool = (toolName: string) => {
    if (limitsDirty.current && toolName !== openId) {
      toast({ tone: 'error', title: 'Unsaved limits', description: `Save or discard your changes to ${openId} first.` })
      return
    }
    setOpen(toolName)
  }

  const openIndex = rows ? rows.findIndex((r) => r.tool_name === openId) : -1
  const step = (delta: 1 | -1) => {
    if (!rows?.length) return
    setOpen(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].tool_name)
  }
  const enabledCount = integrations?.filter((i) => i.enabled).length

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Integrations"
        description="Turn tools on or off and tune their timeout and retries. Changes apply to runs started after you save; a disabled tool is removed from what the agent can call, not just hidden here."
        toolbar={
          <>
            <SearchInput label="Search tools" placeholder="Search tools" value={q} onValueChange={setQ} className="w-full sm:w-64" />
            <Segmented
              label="Enabled state"
              value={state}
              onChange={setState}
              options={[
                { value: 'all', label: 'All', count: integrations?.length },
                { value: 'enabled', label: 'Enabled', count: enabledCount },
                { value: 'disabled', label: 'Disabled', count: integrations ? integrations.length - (enabledCount ?? 0) : undefined },
              ]}
            />
            {active && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
      />

      {error && integrations === null ? (
        <ErrorState message={error} onRetry={retry} />
      ) : rows === null ? (
        <TableSkeleton rows={6} columns={3} />
      ) : integrations?.length === 0 ? (
        <EmptyState
          icon={<Plug size={22} weight="duotone" />}
          title="No integrations configured"
          description="Tools appear here once the harness registers them. Check that the backend started cleanly, then refresh."
          action={
            <Button variant="secondary" onClick={retry}>
              Refresh
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="tools" onClear={clearFilters} />
      ) : (
        <Table label="Tools">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="hidden sm:table-cell">Limits</th>
              <th className="hidden md:table-cell">Updated</th>
              <th className="w-24 text-right">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((integration) => (
              <Row key={integration.tool_name} onOpen={() => openTool(integration.tool_name)} selected={integration.tool_name === openId}>
                <td className="max-w-0 min-w-[10rem]">
                  <span className="font-data flex items-center gap-2 text-[13px] font-medium text-zinc-900">
                    <Plug size={14} className="shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="truncate">{integration.tool_name}</span>
                  </span>
                </td>
                <td className="hidden sm:table-cell">
                  {hasCustomLimits(integration) ? (
                    <Chip tone="neutral" icon={<ShieldCheck size={12} aria-hidden="true" />}>
                      {limitsSummary(integration)}
                    </Chip>
                  ) : (
                    <span className="text-xs text-zinc-500">Defaults</span>
                  )}
                </td>
                <td className="hidden text-xs text-zinc-500 md:table-cell">
                  <RelativeTime value={integration.updated_at} />
                </td>
                <td className="text-right">
                  <Switch
                    checked={integration.enabled}
                    label={`${integration.enabled ? 'Disable' : 'Enable'} ${integration.tool_name}`}
                    disabled={!canMutate}
                    title={mutateTitle}
                    pending={updating.has(integration.tool_name)}
                    onChange={(next) => void toggle(integration.tool_name, next)}
                  />
                </td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}

      {openId && (
        <ToolDetail
          tool={openId}
          listed={integrations?.find((i) => i.tool_name === openId) ?? null}
          refreshToken={refreshToken}
          onLimitsSaved={replaceIntegration}
          enabledPending={updating.has(openId)}
          onToggle={(next) => void toggle(openId, next)}
          onClose={() => setOpen('')}
          onPrev={rows && rows.length > 1 ? () => step(-1) : undefined}
          onNext={rows && rows.length > 1 ? () => step(1) : undefined}
          onDirtyChange={setLimitsDirty}
        />
      )}
    </div>
  )
}
