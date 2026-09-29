import { CaretDown, PaperPlaneTilt } from '@phosphor-icons/react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { ApiError, api } from '../lib/api'

const EXAMPLE_OBJECTIVES = [
  'What is the status of auth-service?',
  'search-index is down, please create an incident',
  'payments-api seems degraded, can you look into it?',
]

export function NewRunPage() {
  const navigate = useNavigate()
  const [objective, setObjective] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxSteps, setMaxSteps] = useState('')
  const [maxWallClock, setMaxWallClock] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = objective.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const { run_id } = await api.startRun({
        objective: trimmed,
        max_steps: maxSteps ? Number(maxSteps) : undefined,
        max_wall_clock_seconds: maxWallClock ? Number(maxWallClock) : undefined,
      })
      navigate(`/runs/${run_id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start run.')
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold text-zinc-100">Start a new run</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Give the ops assistant an objective. It will decide which tools to call, pause for your approval
        before creating an incident, and stream its trace live below.
      </p>

      <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
        <div>
          <label htmlFor="objective" className="mb-1.5 block text-xs font-medium text-zinc-400">
            Objective
          </label>
          <textarea
            id="objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="e.g. search-index is down, please create an incident"
            rows={3}
            className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLE_OBJECTIVES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setObjective(example)}
                className="rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-300"
          >
            <CaretDown
              size={12}
              weight="bold"
              className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            />
            Advanced limits
          </button>
          {showAdvanced && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="max-steps" className="mb-1 block text-xs text-zinc-500">
                  Max steps
                </label>
                <input
                  id="max-steps"
                  type="number"
                  min={1}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                  placeholder="12 (default)"
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="max-wall-clock" className="mb-1 block text-xs text-zinc-500">
                  Max wall clock (s)
                </label>
                <input
                  id="max-wall-clock"
                  type="number"
                  min={1}
                  value={maxWallClock}
                  onChange={(e) => setMaxWallClock(e.target.value)}
                  placeholder="60 (default)"
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {error && <ErrorBanner message={error} />}

        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PaperPlaneTilt size={16} weight="bold" />
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </form>
    </div>
  )
}
