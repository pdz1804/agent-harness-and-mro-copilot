import { ArrowClockwise, PlusCircle, ShieldCheck } from '@phosphor-icons/react'
import { useEffect, useId, useState } from 'react'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { TestSandbox } from '../components/guardrails/TestSandbox'
import { TriggerHistory } from '../components/guardrails/TriggerHistory'
import { PageHeader } from '../components/ui/PageHeader'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { Guardrail, GuardrailTrigger } from '../lib/api-types'
import { kindLabel } from '../lib/guardrail-sandbox'

/** Guardrails: the harness's two real, enforced guardrails.
 * `objective_pattern_block` (input) ends a run immediately with a
 * `guardrail_blocked` trace event before the agent loop starts;
 * `severity_upgrade_block` (output) caps an unsupported `critical`
 * `create_incident` severity to `high` next to the approval gate. Toggling
 * takes effect on the very next run/tool call, since both enforcement points
 * read the table fresh every time. The sandbox dry-runs both with the same
 * logic; the history lists real recorded triggers linked to their runs. */
export function GuardrailsPage() {
  const uid = useId()
  const [guardrails, setGuardrails] = useState<Guardrail[] | null>(null)
  const [triggers, setTriggers] = useState<GuardrailTrigger[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const [newName, setNewName] = useState('')
  const [newPatterns, setNewPatterns] = useState('')
  const [creating, setCreating] = useState(false)

  const { me } = useMe()
  const canMutate = me ? me.permissions.includes('mutate_guardrails') : true
  const mutateTitle = canMutate ? undefined : disabledReason(me, 'mutate_guardrails')

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listGuardrails(), api.listGuardrailTriggers()])
      .then(([g, t]) => {
        if (cancelled) return
        setGuardrails(g)
        setTriggers(t)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load guardrails.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const handleToggle = async (guardrailId: string, enabled: boolean) => {
    setUpdating(guardrailId)
    try {
      const updated = await api.setGuardrailEnabled(guardrailId, enabled)
      setGuardrails((prev) => (prev ? prev.map((g) => (g.id === guardrailId ? updated : g)) : prev))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update guardrail.')
    } finally {
      setUpdating(null)
    }
  }

  const handleCreate = async () => {
    const patterns = newPatterns
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!newName.trim() || patterns.length === 0) return
    setCreating(true)
    try {
      await api.createGuardrail({
        name: newName.trim(),
        kind: 'objective_pattern_block',
        config: { patterns },
      })
      setNewName('')
      setNewPatterns('')
      setError(null)
      setRefreshToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create guardrail.')
    } finally {
      setCreating(false)
    }
  }

  const retry = () => {
    setError(null)
    setRefreshToken((n) => n + 1)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Guardrails"
        description={
          <>
            Real, enforced checks: a banned objective pattern ends a run immediately, and an unsupported{' '}
            <code className="font-data">critical</code> incident severity is downgraded to{' '}
            <code className="font-data">high</code> before the approval gate.
          </>
        }
        actions={
          <button type="button" onClick={retry} className="ui-btn ui-btn-secondary">
            <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
            Refresh
          </button>
        }
      />

      <TestSandbox guardrails={guardrails} />

      {error && <ErrorBanner message={error} onRetry={retry} />}

      <section aria-labelledby={`${uid}-rules`}>
        <h2 id={`${uid}-rules`} className="ui-section-label mb-2">
          Rules
        </h2>
        {!error && guardrails === null ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : guardrails && guardrails.length > 0 ? (
          <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
            {guardrails.map((guardrail) => {
              const patterns = Array.isArray(guardrail.config.patterns) ? (guardrail.config.patterns as string[]) : []
              return (
                <li key={guardrail.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ShieldCheck size={14} className="shrink-0 text-zinc-600" aria-hidden="true" />
                      <span className="text-[13px] font-medium text-zinc-900 [overflow-wrap:anywhere]">
                        {guardrail.name}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-600 [overflow-wrap:anywhere]">
                      {kindLabel(guardrail.kind)}
                      {guardrail.kind === 'objective_pattern_block' && patterns.length > 0 && (
                        <>
                          {' — patterns: '}
                          <span className="font-data">{patterns.join(', ')}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={guardrail.enabled}
                    aria-label={`${guardrail.enabled ? 'Disable' : 'Enable'} ${guardrail.name}`}
                    disabled={!canMutate || updating === guardrail.id}
                    title={mutateTitle}
                    onClick={() => void handleToggle(guardrail.id, !guardrail.enabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      guardrail.enabled ? 'bg-sky-600' : 'bg-zinc-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white transition-transform ${
                        guardrail.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          !error && (
            <p className="text-[13px] text-zinc-600">
              No guardrails configured. Add a banned-pattern rule below to start blocking objectives.
            </p>
          )
        )}

        <div className="mt-3 ui-card p-4">
          <p className="mb-2 text-xs font-medium text-zinc-700">New input guardrail: banned objective patterns</p>
          <label htmlFor={`${uid}-name`} className="mb-1 block text-xs text-zinc-600">
            Name
          </label>
          <input
            id={`${uid}-name`}
            name="guardrail-name"
            autoComplete="off"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Block destructive requests…"
            disabled={!canMutate}
            className="ui-input mb-2 w-full"
          />
          <label htmlFor={`${uid}-patterns`} className="mb-1 block text-xs text-zinc-600">
            Banned patterns, one per line
          </label>
          <textarea
            id={`${uid}-patterns`}
            name="guardrail-patterns"
            autoComplete="off"
            spellCheck={false}
            value={newPatterns}
            onChange={(e) => setNewPatterns(e.target.value)}
            rows={3}
            disabled={!canMutate}
            placeholder={'delete all data\nwipe the database'}
            className="ui-input w-full font-data"
          />
          <button
            type="button"
            disabled={!canMutate || creating || !newName.trim() || !newPatterns.trim()}
            title={mutateTitle}
            onClick={() => void handleCreate()}
            className="ui-btn ui-btn-secondary mt-2"
          >
            <PlusCircle size={14} weight="bold" aria-hidden="true" />
            {creating ? 'Creating…' : 'Create guardrail'}
          </button>
        </div>
      </section>

      <section aria-labelledby={`${uid}-history`}>
        <h2 id={`${uid}-history`} className="ui-section-label mb-2">
          Trigger history
        </h2>
        {!error && triggers === null ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : triggers && triggers.length > 0 ? (
          <TriggerHistory triggers={triggers} />
        ) : (
          !error && (
            <p className="text-[13px] text-zinc-600">
              No guardrail has fired yet. When a run is blocked or a severity is downgraded, it shows up here with a
              link to the run.
            </p>
          )
        )}
      </section>
    </div>
  )
}
