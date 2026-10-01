import { CaretDown, Sparkle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Composer } from '../components/chat/Composer'
import { ErrorBanner } from '../components/ErrorBanner'
import { ApiError, api } from '../lib/api'
import type { Agent, StarterPrompt } from '../lib/api-types'

/** Chat-product-style composer: a centered welcome area (like a fresh
 * ChatGPT/Claude conversation) with the objective input docked at the
 * bottom of the viewport, not a full-page form. Submitting starts a real
 * async run and navigates to its chat view (RunPage), where the objective
 * becomes the first message bubble. */
export function NewRunPage() {
  const navigate = useNavigate()
  const [objective, setObjective] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxSteps, setMaxSteps] = useState('')
  const [maxWallClock, setMaxWallClock] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [agentId, setAgentId] = useState<string>('')
  const [starters, setStarters] = useState<StarterPrompt[]>([])

  useEffect(() => {
    api
      .listAgents()
      .then((list) => {
        setAgents(list)
        setAgentId(list.find((a) => a.is_default)?.id ?? list[0]?.id ?? '')
      })
      .catch(() => setAgents([]))
  }, [])

  // Starter prompts are per agent: the examples of the skills this agent can
  // actually use for the current user (server-filtered by RBAC + Integrations).
  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    api
      .getAgentStarters(agentId)
      .then((list) => {
        if (!cancelled) setStarters(list)
      })
      .catch(() => {
        if (!cancelled) setStarters([])
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleSubmit = async (trimmed: string) => {
    setSubmitting(true)
    setError(null)
    try {
      const { run_id } = await api.startRun({
        objective: trimmed,
        max_steps: maxSteps ? Number(maxSteps) : undefined,
        max_wall_clock_seconds: maxWallClock ? Number(maxWallClock) : undefined,
        agent_id: agentId || undefined,
      })
      navigate(`/runs/${run_id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start run.')
      setSubmitting(false)
    }
  }

  return (
    <div className="relative mx-auto flex min-h-full max-w-[47.5rem] flex-col justify-center py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 mx-auto h-72 max-w-xl rounded-full bg-[radial-gradient(closest-side,oklch(0.608_0.192_280/0.10),transparent)] blur-2xl"
      />
      <div className="relative text-center">
        <span className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-950 text-white shadow-[var(--shadow-lift)]">
          <Sparkle size={20} weight="fill" className="text-sky-300" />
        </span>
        <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-zinc-950 sm:text-[2.25rem]">What's the objective?</h1>
        <p className="mx-auto mt-2 max-w-md text-[15px] text-zinc-500">
          Give the ops assistant a task. It decides which tools to call, pauses for your approval before creating an incident, and
          streams its answer live, token by token.
        </p>
      </div>

      {error && (
        <div className="relative mt-6">
          <ErrorBanner message={error} />
        </div>
      )}

      <div className="relative mt-7">
        <Composer
          agents={agents}
          agentId={agentId}
          onAgentChange={setAgentId}
          value={objective}
          onValueChange={setObjective}
          submitting={submitting}
          placeholder="Message the ops assistant… (e.g. search-index is down, please create an incident)…"
          onSubmit={(trimmed) => void handleSubmit(trimmed)}
        />

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="flex h-7 items-center gap-1 rounded-md px-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
          >
            <CaretDown size={11} weight="bold" className={`transition-transform duration-200 ${showAdvanced ? '' : '-rotate-90'}`} />
            Advanced limits
          </button>
          {showAdvanced && (
            <div className="mt-2 grid animate-rise grid-cols-2 gap-3">
              <div>
                <label htmlFor="max-steps" className="mb-1 block text-xs font-medium text-zinc-600">
                  Max steps
                </label>
                <input name="max-steps" autoComplete="off"
                  id="max-steps"
                  type="number"
                  min={1}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                  placeholder="12 (default)…"
                  className="ui-input w-full"
                />
              </div>
              <div>
                <label htmlFor="max-wall-clock" className="mb-1 block text-xs font-medium text-zinc-600">
                  Max wall clock (s)
                </label>
                <input name="max-wall-clock" autoComplete="off"
                  id="max-wall-clock"
                  type="number"
                  min={1}
                  value={maxWallClock}
                  onChange={(e) => setMaxWallClock(e.target.value)}
                  placeholder="60 (default)…"
                  className="ui-input w-full"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {starters.length > 0 && (
        <div className="relative mt-6">
          <p className="mb-2 px-1 text-xs font-medium text-zinc-500">Try a starter</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {starters.map((starter) => (
              <button
                key={starter.text}
                type="button"
                title={`Uses the ${starter.skill_slug} skill`}
                onClick={() => setObjective(starter.text)}
                className="group flex items-start gap-3 rounded-xl bg-white px-3.5 py-3 text-left text-[13px] text-zinc-700 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] transition-[box-shadow,transform,color] duration-200 hover:-translate-y-px hover:text-zinc-950 hover:shadow-[var(--shadow-lift)]"
              >
                <span className="min-w-0 flex-1 leading-snug">{starter.text}</span>
                <span className="font-data shrink-0 rounded-md bg-zinc-950/[0.04] px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors group-hover:bg-sky-50 group-hover:text-sky-700">
                  /{starter.skill_slug}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
