import { Plus, ShieldCheck } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { CreateRuleSheet } from '../components/guardrails/CreateRuleSheet'
import { RuleSheet } from '../components/guardrails/RuleSheet'
import { TestSandbox } from '../components/guardrails/TestSandbox'
import { TriggerHistory } from '../components/guardrails/TriggerHistory'
import { Button, Chip, EmptyState, ErrorState, FilteredEmpty, PageHeader, Row, SearchInput, Segmented, Switch, Table, TableSkeleton, useToast } from '../components/ui'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { disabledReason, useMe } from '../hooks/useMe'
import { api, errorText } from '../lib/api'
import type { Guardrail, GuardrailTrigger } from '../lib/api-types'
import { kindLabel } from '../lib/guardrail-sandbox'
import { GUARDRAIL_STATE_FILTERS, filterGuardrails, filterTriggers, guardrailPatterns, type GuardrailStateFilter } from '../lib/guardrails-validation'

const TABS = ['rules', 'history', 'sandbox'] as const
const FILTER_KEYS = ['q', 'state']

/** Guardrails: the harness's two real, enforced guardrails.
 * `objective_pattern_block` (input) ends a run immediately with a
 * `guardrail_blocked` trace event before the agent loop starts;
 * `severity_upgrade_block` (output) caps an unsupported `critical`
 * `create_incident` severity to `high` next to the approval gate. Toggling
 * takes effect on the very next run or tool call, since both enforcement points
 * read the table fresh every time. The sandbox dry-runs both with the same
 * logic; the history lists real recorded triggers linked to their runs.
 * Tab, filters, the open rule (`?open=<id>`) and the create sheet
 * (`?create=1`) live in the URL. */
export function GuardrailsPage() {
  const toast = useToast()
  const [tab, setTab] = useUrlEnum('tab', TABS, 'rules')
  const [q, setQ] = useUrlState('q')
  const [state, setState] = useUrlEnum<GuardrailStateFilter>('state', GUARDRAIL_STATE_FILTERS, 'all')
  const [openId, setOpenId] = useUrlState('open')
  const [create, setCreate] = useUrlState('create')
  const clearParams = useClearUrlParams()
  const [guardrails, setGuardrails] = useState<Guardrail[] | null>(null)
  const [triggers, setTriggers] = useState<GuardrailTrigger[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<Set<string>>(() => new Set())
  const [refreshToken, setRefreshToken] = useState(0)

  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_guardrails') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_guardrails')

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listGuardrails(), api.listGuardrailTriggers()]).then(
      ([g, t]) => {
        if (cancelled) return
        setGuardrails(g)
        setTriggers(t)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err, 'Failed to load guardrails.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const replace = (updated: Guardrail) => setGuardrails((prev) => (prev ? prev.map((g) => (g.id === updated.id ? updated : g)) : prev))
  const setPending = (id: string, on: boolean) =>
    setUpdating((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  /** Flip a rule; the toast's Undo flips it back. */
  const toggle = async (guardrail: Guardrail, enabled: boolean) => {
    setPending(guardrail.id, true)
    try {
      replace(await api.setGuardrailEnabled(guardrail.id, enabled))
      toast({
        title: `${enabled ? 'Enabled' : 'Disabled'} “${guardrail.name}”`,
        description: 'Applies to the next run.',
        action: {
          label: 'Undo',
          run: async () => {
            replace(await api.setGuardrailEnabled(guardrail.id, !enabled))
          },
        },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't ${enabled ? 'enable' : 'disable'} “${guardrail.name}”`, description: errorText(err, 'Try again.') })
    } finally {
      setPending(guardrail.id, false)
    }
  }

  const rules = useMemo(() => (guardrails ? filterGuardrails(guardrails, q, state) : null), [guardrails, q, state])
  const history = useMemo(() => (triggers ? filterTriggers(triggers, q) : null), [triggers, q])
  const filtersActive = q.trim() !== '' || (tab === 'rules' && state !== 'all')
  const clearFilters = () => clearParams(FILTER_KEYS)
  const retry = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }

  const openIndex = rules ? rules.findIndex((g) => g.id === openId) : -1
  const step = (delta: 1 | -1) => {
    if (!rules?.length) return
    setOpenId(rules[(Math.max(0, openIndex) + delta + rules.length) % rules.length].id)
  }

  const newRuleButton = (
    <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setCreate('1')} disabled={!canMutate} title={mutateTitle}>
      New rule
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Guardrails"
        description="Real, enforced checks: a banned objective pattern ends a run immediately, and an unsupported critical incident severity is downgraded to high before the approval gate."
        actions={newRuleButton}
        toolbar={
          <>
            <Segmented
              label="Guardrail sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'rules', label: 'Rules', count: guardrails?.length },
                { value: 'history', label: 'Trigger history', count: triggers?.length },
                { value: 'sandbox', label: 'Test sandbox' },
              ]}
            />
            {tab !== 'sandbox' && <SearchInput label={tab === 'rules' ? 'Search rules' : 'Search trigger history'} placeholder={tab === 'rules' ? 'Search rules and patterns' : 'Search rule, run or objective'} value={q} onValueChange={setQ} className="w-full sm:w-64" />}
            {tab === 'rules' && (
              <Segmented
                label="Enabled state"
                value={state}
                onChange={setState}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'enabled', label: 'Enabled' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
              />
            )}
            {tab !== 'sandbox' && filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </>
        }
      />

      {tab === 'sandbox' ? (
        <TestSandbox guardrails={guardrails} />
      ) : error && guardrails === null ? (
        <ErrorState message={error} onRetry={retry} />
      ) : tab === 'rules' ? (
        rules === null ? (
          <TableSkeleton rows={3} columns={3} />
        ) : guardrails?.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={22} weight="duotone" />}
            title="No guardrails configured"
            description="Block objectives that match a banned pattern before the agent starts."
            action={newRuleButton}
            example="Try: “delete all data” or “wipe the database”."
          />
        ) : rules.length === 0 ? (
          <FilteredEmpty query={q || undefined} what="rules" onClear={clearFilters} />
        ) : (
          <Table label="Guardrail rules">
            <thead>
              <tr>
                <th>Rule</th>
                <th className="hidden md:table-cell">Type</th>
                <th className="hidden sm:table-cell">Patterns</th>
                <th className="w-24 text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((g) => {
                const patterns = guardrailPatterns(g)
                return (
                  <Row key={g.id} onOpen={() => setOpenId(g.id)} selected={g.id === openId}>
                    <td className="max-w-0 min-w-[10rem]">
                      <p className="flex items-center gap-2 truncate font-medium text-zinc-900">
                        <ShieldCheck size={14} className="shrink-0 text-zinc-500" aria-hidden="true" />
                        <span className="truncate">{g.name}</span>
                      </p>
                    </td>
                    <td className="hidden md:table-cell">
                      <Chip tone="violet">{g.kind === 'objective_pattern_block' ? 'Input' : 'Output'}</Chip>
                      <span className="ml-2 text-xs text-zinc-500">{kindLabel(g.kind).replace(/ \((input|output)\)$/, '')}</span>
                    </td>
                    <td className="hidden max-w-[16rem] sm:table-cell">
                      {g.kind === 'objective_pattern_block' ? (
                        <span className="font-data block truncate text-xs text-zinc-600" title={patterns.join(', ')}>
                          {patterns.length ? patterns.join(', ') : 'None'}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-500">Built in</span>
                      )}
                    </td>
                    <td className="text-right">
                      <Switch
                        checked={g.enabled}
                        label={`${g.enabled ? 'Disable' : 'Enable'} ${g.name}`}
                        disabled={!canMutate}
                        title={mutateTitle}
                        pending={updating.has(g.id)}
                        onChange={(next) => void toggle(g, next)}
                      />
                    </td>
                  </Row>
                )
              })}
            </tbody>
          </Table>
        )
      ) : history === null ? (
        <TableSkeleton rows={4} columns={4} />
      ) : triggers?.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={22} weight="duotone" />}
          title="No guardrail has fired yet"
          description="When a run is blocked or a severity is downgraded, it shows up here with a link to the run."
          example="Use the test sandbox to see what a rule would do without running anything."
        />
      ) : history.length === 0 ? (
        <FilteredEmpty query={q || undefined} what="triggers" onClear={clearFilters} />
      ) : (
        <TriggerHistory triggers={history} />
      )}

      {openId && (
        <RuleSheet
          guardrail={guardrails?.find((g) => g.id === openId) ?? null}
          loading={guardrails === null}
          triggers={triggers ?? []}
          canMutate={canMutate}
          reason={mutateTitle}
          pending={updating.has(openId)}
          onToggle={(next) => {
            const g = guardrails?.find((x) => x.id === openId)
            if (g) void toggle(g, next)
          }}
          onClose={() => setOpenId('')}
          onPrev={rules && rules.length > 1 ? () => step(-1) : undefined}
          onNext={rules && rules.length > 1 ? () => step(1) : undefined}
        />
      )}

      {create && (
        <CreateRuleSheet
          canMutate={canMutate}
          reason={mutateTitle}
          onClose={() => setCreate('')}
          onCreated={(created) => setGuardrails((prev) => (prev ? [...prev, created] : prev))}
        />
      )}
    </div>
  )
}
