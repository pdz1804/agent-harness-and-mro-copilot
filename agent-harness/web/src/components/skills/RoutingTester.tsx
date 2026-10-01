import { CheckCircle, Circle, MinusCircle, Path } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { Agent, RouteTestResult, Skill } from '../../lib/api-types'
import { confidencePercent, describeRouting, droppedPicks, formatLatency } from '../../lib/routing-result'
import { Button, Card, CardHeader, Chip, ErrorBanner, Field, Select, Textarea, type ChipTone } from '../ui'

const MAX_OBJECTIVE = 2000
const MAX_EXAMPLE_CHIPS = 6

const TONE_LABEL = {
  picked: 'Skill picked',
  dropped: 'Dropped by threshold',
  none: 'No skill',
  forced: 'Forced',
} as const

const TONE_CHIP: Record<keyof typeof TONE_LABEL, ChipTone> = {
  picked: 'ok',
  dropped: 'warn',
  none: 'neutral',
  forced: 'iris',
}

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
        <div className={`h-2 rounded-full ${above ? 'bg-sky-600' : 'bg-zinc-500'}`} style={{ width: `${percent}%` }} />
        <div className="absolute -top-1 h-4 w-0.5 bg-zinc-900" style={{ left: `${thresholdPercent}%` }} aria-hidden="true" />
      </div>
    </div>
  )
}

function ResultCard({ result }: { result: RouteTestResult }) {
  const described = describeRouting(result)
  const dropped = new Set(droppedPicks(result))
  const showMeter = result.mode === 'router'
  return (
    <Card className="space-y-3" aria-live="polite" data-testid="routing-result">
      <CardHeader title="Router result" actions={<Chip tone={TONE_CHIP[described.tone]} dot>{TONE_LABEL[described.tone]}</Chip>} />
      <p className="text-sm font-semibold text-zinc-900 [overflow-wrap:anywhere]">{described.headline}</p>

      {showMeter && <ConfidenceMeter confidence={result.confidence} threshold={result.threshold} />}

      {described.detail && (
        <p className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">
          <span className="font-medium text-zinc-900">Rationale: </span>
          {described.detail}
        </p>
      )}
      <p className="text-xs text-zinc-600 tabular-nums">Router latency: {formatLatency(result.latency_ms)}</p>

      <div>
        <p className="mb-1.5 text-xs font-medium text-zinc-500">Candidates ({result.candidates.length})</p>
        {result.candidates.length === 0 ? (
          <p className="text-xs text-zinc-600">No readable skills to route over. Create or enable a skill first.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-[10px] border border-[var(--color-line)]">
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
                      <span className="font-medium">{c.name}</span> <span className="font-data text-xs text-zinc-600">/{c.slug}</span>
                    </p>
                    <p className="line-clamp-2 text-xs text-zinc-600 [overflow-wrap:anywhere]">{c.description}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-zinc-700">{c.selected ? 'Selected' : isDropped ? 'Proposed but dropped' : 'Not picked'}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

/** Dry-runs the real auto-mode skill router for an objective, without
 * creating a run. Costs one small LLM call, so it only runs on click. */
export function RoutingTester({ skills, initialObjective = '' }: { skills: Skill[] | null; initialObjective?: string }) {
  const [objective, setObjective] = useState(initialObjective.slice(0, MAX_OBJECTIVE))
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RouteTestResult | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        // The agent picker is optional: without it the test runs over all readable skills.
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      setError(errorText(err, 'Routing test failed. Check the backend is reachable and retry.'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <Path size={15} weight="bold" className="text-sky-700" aria-hidden="true" />
              Routing tester
            </span>
          }
          meta="See which skill the auto router would pick for an objective."
        />
        <Field label="What would a user ask?" hint="Ctrl/Cmd+Enter runs it. Uses one small model call; no run is created.">
          {({ id, ...aria }) => (
            <div>
              <Textarea
                id={id}
                {...aria}
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
                className="block w-full resize-y"
              />
              <span className="mt-1 block text-right text-xs text-zinc-600 tabular-nums">
                {objective.length}/{MAX_OBJECTIVE}
              </span>
            </div>
          )}
        </Field>

        {examples.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Example prompts from your skills">
            <span className="text-xs text-zinc-600">Try:</span>
            {examples.map((example) => (
              <Button key={example} size="sm" className="!h-auto max-w-full py-1 text-left !whitespace-normal [overflow-wrap:anywhere]" onClick={() => setObjective(example.slice(0, MAX_OBJECTIVE))}>
                {example}
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="As agent" className="min-w-48">
            {({ id }) => (
              <Select id={id} name="routing-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="block w-full">
                <option value="">All readable skills</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="primary" loading={running} disabled={!canRun} onClick={() => void run()}>
            {running ? 'Routing' : 'Which skill would be picked?'}
          </Button>
        </div>
      </Card>

      {error && <ErrorBanner message={error} />}
      {result && <ResultCard result={result} />}
    </div>
  )
}
