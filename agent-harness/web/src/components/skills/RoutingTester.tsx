import { CaretDown, CaretRight, CheckCircle, Circle, MinusCircle, Path } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { ApiError, api } from '../../lib/api'
import type { Agent, RouteTestResult, Skill } from '../../lib/api-types'
import { confidencePercent, describeRouting, droppedPicks, formatLatency } from '../../lib/routing-result'
import { ErrorBanner } from '../ErrorBanner'

const MAX_OBJECTIVE = 2000
const MAX_EXAMPLE_CHIPS = 6

const TONE_LABEL = {
  picked: 'Skill picked',
  dropped: 'Dropped by threshold',
  none: 'No skill',
  forced: 'Forced',
} as const

/** Horizontal confidence bar with a tick at the threshold. Value is always
 * printed next to it, so meaning never depends on colour. */
function ConfidenceMeter({ confidence, threshold }: { confidence: number; threshold: number }) {
  const percent = confidencePercent(confidence)
  const thresholdPercent = confidencePercent(threshold)
  const above = confidence >= threshold
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs text-zinc-600 tabular-nums">
        <span>
          Confidence <span className="font-semibold text-zinc-900">{confidence.toFixed(2)}</span>
        </span>
        <span>
          Threshold <span className="font-semibold text-zinc-900">{threshold.toFixed(2)}</span>
          {above ? ' (met)' : ' (not met)'}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Router confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${confidence.toFixed(2)} of 1, threshold ${threshold.toFixed(2)}`}
        className="relative h-2 rounded-full bg-zinc-200"
      >
        <div
          className={`h-2 rounded-full ${above ? 'bg-sky-600' : 'bg-zinc-500'}`}
          style={{ width: `${percent}%` }}
        />
        <div
          className="absolute -top-1 h-4 w-0.5 bg-zinc-900"
          style={{ left: `${thresholdPercent}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

function ResultCard({ result }: { result: RouteTestResult }) {
  const described = describeRouting(result)
  const dropped = new Set(droppedPicks(result))
  const showMeter = result.mode === 'router'
  return (
    <div className="ui-card space-y-3 p-4" aria-live="polite" data-testid="routing-result">
      <div>
        <p className="ui-section-label">{TONE_LABEL[described.tone]}</p>
        <p className="mt-1 text-sm font-semibold text-zinc-900 [overflow-wrap:anywhere]">{described.headline}</p>
      </div>

      {showMeter && <ConfidenceMeter confidence={result.confidence} threshold={result.threshold} />}

      {described.detail && (
        <p className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">
          <span className="font-medium text-zinc-900">Rationale: </span>
          {described.detail}
        </p>
      )}
      <p className="text-xs text-zinc-600 tabular-nums">Router latency: {formatLatency(result.latency_ms)}</p>

      <div>
        <p className="ui-section-label mb-1.5">Candidates ({result.candidates.length})</p>
        {result.candidates.length === 0 ? (
          <p className="text-xs text-zinc-600">No readable skills to route over. Create or enable a skill first.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {result.candidates.map((c) => {
              const isDropped = dropped.has(c.slug)
              return (
                <li key={c.slug} className="flex items-start gap-2 px-3 py-2">
                  {c.selected ? (
                    <CheckCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-emerald-700" aria-hidden="true" />
                  ) : isDropped ? (
                    <MinusCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
                  ) : (
                    <Circle size={15} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-zinc-900 [overflow-wrap:anywhere]">
                      <span className="font-medium">{c.name}</span>{' '}
                      <span className="font-data text-xs text-zinc-600">/{c.slug}</span>
                    </p>
                    <p className="line-clamp-2 text-xs text-zinc-600 [overflow-wrap:anywhere]">{c.description}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-zinc-700">
                    {c.selected ? 'Selected' : isDropped ? 'Proposed but dropped' : 'Not picked'}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Dry-runs the real auto-mode skill router for an objective, without
 * creating a run. Costs one small LLM call, so it only runs on click. */
export function RoutingTester({ skills }: { skills: Skill[] | null }) {
  const [open, setOpen] = useLocalStorageState('skills.routing-tester.open', false)
  const [objective, setObjective] = useState('')
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RouteTestResult | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const examples = useMemo(() => {
    const seen = new Set<string>()
    for (const skill of skills ?? []) {
      if (!skill.enabled) continue
      for (const example of skill.examples) {
        const text = example.trim()
        if (text) seen.add(text)
      }
    }
    return [...seen].slice(0, MAX_EXAMPLE_CHIPS)
  }, [skills])

  const canRun = objective.trim().length > 0 && !running

  const run = async () => {
    if (!canRun) return
    setRunning(true)
    setError(null)
    try {
      setResult(
        await api.testSkillRouting({
          objective: objective.trim(),
          ...(agentId ? { agent_id: agentId } : {}),
        }),
      )
    } catch (err) {
      setResult(null)
      setError(err instanceof ApiError ? err.message : 'Routing test failed. Check the backend is reachable and retry.')
    } finally {
      setRunning(false)
    }
  }

  const Caret = open ? CaretDown : CaretRight

  return (
    <section className="ui-card mt-4" aria-labelledby="routing-tester-title">
      <h2 id="routing-tester-title" className="text-sm font-semibold text-zinc-900">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="routing-tester-body"
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
        >
          <Caret size={13} weight="bold" aria-hidden="true" />
          <Path size={15} weight="bold" className="text-sky-700" aria-hidden="true" />
          Routing tester
          <span className="text-xs font-normal text-zinc-600">See which skill the auto router would pick</span>
        </button>
      </h2>

      {open && (
        <div id="routing-tester-body" className="space-y-3 border-t border-zinc-100 px-4 py-4">
          <label className="block text-xs font-medium text-zinc-700">
            What would a user ask?
            <textarea
              name="routing-objective"
              autoComplete="off"
              value={objective}
              maxLength={MAX_OBJECTIVE}
              rows={3}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void run()
                }
              }}
              placeholder="e.g. checkout is returning 500s, who is on call?"
              className="ui-input mt-1 block w-full resize-y"
            />
            <span className="mt-1 block text-right text-xs text-zinc-600 tabular-nums">
              {objective.length}/{MAX_OBJECTIVE}
            </span>
          </label>

          {examples.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Example prompts from your skills">
              <span className="text-xs text-zinc-600">Try:</span>
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setObjective(example.slice(0, MAX_OBJECTIVE))}
                  className="ui-btn ui-btn-secondary ui-btn-sm h-auto max-w-full whitespace-normal py-1 text-left [overflow-wrap:anywhere]"
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-xs font-medium text-zinc-700">
              As agent
              <select
                name="routing-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="ui-input mt-1 block min-w-48"
              >
                <option value="">All readable skills</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void run()} disabled={!canRun} className="ui-btn ui-btn-primary">
              {running ? 'Routing…' : 'Which skill would be picked?'}
            </button>
            <span className="pb-2 text-xs text-zinc-600">Ctrl/Cmd+Enter. Uses one small model call; no run is created.</span>
          </div>

          {error && <ErrorBanner message={error} />}
          {result && <ResultCard result={result} />}
        </div>
      )}
    </section>
  )
}
