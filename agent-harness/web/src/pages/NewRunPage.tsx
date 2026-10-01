import { CaretRight, Sparkle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Composer } from '../components/chat/Composer'
import { Button, ErrorBanner, Field, Input } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { limitError } from '../lib/run-limits'
import type { Agent, StarterPrompt } from '../lib/api-types'
import { useMe } from '../hooks/useMe'
import { attentionChips, firstName, type AttentionChip } from '../lib/attention'
import { Chip } from '../components/ui/Chip'

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
  const [chips, setChips] = useState<AttentionChip[]>([])
  const { me } = useMe()
  const name = firstName(me?.display_name)

  // Live "needs attention" chips; a failed fetch just hides them.
  useEffect(() => {
    let cancelled = false
    Promise.all([api.listServices(), api.listIncidents({ status: 'open' })])
      .then(([services, incidents]) => {
        if (!cancelled) setChips(attentionChips(services, incidents))
      })
      .catch(() => {
        if (!cancelled) setChips([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    api
      .listAgents()
      .then((list) => {
        setAgents(list)
        // `?agent=<id>` (the Agents page's "Start run") preselects that agent.
        const wanted = new URLSearchParams(window.location.search).get('agent')
        setAgentId(list.find((a) => a.id === wanted)?.id ?? list.find((a) => a.is_default)?.id ?? list[0]?.id ?? '')
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
    if (limitError(maxSteps) || limitError(maxWallClock)) {
      setShowAdvanced(true)
      setError('Fix the advanced limits first, or clear them to use the defaults.')
      return
    }
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
        <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-zinc-950 sm:text-[2.25rem]">
          {name ? `What needs attention, ${name}?` : 'What needs attention?'}
        </h1>
        {chips.length > 0 ? (
          <ul aria-label="Needs attention" className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {chips.map((chip) => (
              <li key={chip.key}>
                <Link to={chip.to} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500">
                  <Chip tone={chip.tone} dot={chip.tone !== 'neutral'} className="hover:brightness-95">
                    {chip.label}
                  </Chip>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mx-auto mt-2 max-w-md text-[15px] text-zinc-500">
            Give the agent a task. It picks the tools, asks before any write, and streams its answer live.
          </p>
        )}
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
          placeholder={`Message ${agents?.find((a) => a.id === agentId)?.name ?? 'the agent'} (e.g. search-index is down, please open an incident)`}
          clearOnSubmit={false}
          onSubmit={(trimmed) => void handleSubmit(trimmed)}
        />

        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            icon={<CaretRight size={11} weight="bold" className="ui-fold-chevron" />}
          >
            Advanced limits
          </Button>
          {showAdvanced && (
            <div className="mt-2 grid animate-rise grid-cols-2 gap-3">
              <Field label="Max steps" hint="Default 12" error={limitError(maxSteps)}>
                {(f) => (
                  <Input {...f} name="max-steps" autoComplete="off" type="number" min={1} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} placeholder="12" className="w-full" />
                )}
              </Field>
              <Field label="Max wall clock (s)" hint="Default 60" error={limitError(maxWallClock)}>
                {(f) => (
                  <Input
                    {...f}
                    name="max-wall-clock"
                    autoComplete="off"
                    type="number"
                    min={1}
                    value={maxWallClock}
                    onChange={(e) => setMaxWallClock(e.target.value)}
                    placeholder="60"
                    className="w-full"
                  />
                )}
              </Field>
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
                className="group flex snap-start items-start gap-3 rounded-[14px] bg-white px-3.5 py-3 text-left text-[13px] text-zinc-700 shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-line)] transition-[box-shadow,transform,color] duration-200 hover:-translate-y-px hover:text-zinc-950 hover:shadow-[var(--shadow-lift)]"
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
