import { Play } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EvalRunsTab } from '../components/evals/EvalRunsTab'
import { OfflineSuiteTab } from '../components/evals/OfflineSuiteTab'
import { OverviewTab } from '../components/evals/OverviewTab'
import { Button, PageHeader, SearchInput, Segmented, Select, useToast } from '../components/ui'
import { disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api, errorText } from '../lib/api'
import type { EvalRunSummary } from '../lib/api-types'
import { EVAL_RUN_STATUSES, hasEvalRunFilters } from '../lib/evals-runs'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'

const TABS = ['overview', 'runs', 'offline'] as const
const RUN_FILTER_KEYS = ['q', 'status']
const STATUS_LABEL: Record<string, string> = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' }
const SCORE_LIMIT = 200

/** Evals: an in-app LLM-as-judge eval agent that scores real chat runs
 * (task success, groundedness, tool use, safety, routing fit plus
 * deterministic trace metrics), a metrics overview with trends, and the
 * offline recorded-transcript regression suite's MLflow results. The tab and
 * the scoring-run filters live in the URL; a scoring run opens as a full page
 * at `/evals/runs/:id`. */
export function EvalsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [tab, setTab] = useUrlEnum('tab', TABS, 'overview')
  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlState('status')
  const [sortRaw, setSortRaw] = useUrlState('sort')
  const clearParams = useClearUrlParams()
  const { me } = useMe()
  const canRunEvals = me ? me.permissions.includes('run_evals') : true
  const runReason = canRunEvals ? undefined : disabledReason(me, 'run_evals')

  const [runs, setRuns] = useState<EvalRunSummary[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (tab !== 'runs') return
    let cancelled = false
    api.listEvalRuns().then(
      (data) => {
        if (cancelled) return
        setRuns(data)
        setRunsError(null)
      },
      (err: unknown) => {
        if (!cancelled) setRunsError(errorText(err, 'Failed to load scoring runs.'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [tab, reloadToken])

  const reloadRuns = useCallback(() => setReloadToken((n) => n + 1), [])

  const startScoring = async () => {
    setStarting(true)
    try {
      const run = await api.startEvalRun({ scope: 'mine', limit: SCORE_LIMIT })
      reloadRuns()
      toast({
        title: 'Scoring started',
        description: `Scoring up to ${SCORE_LIMIT} of your runs.`,
        action: { label: 'Open', run: () => navigate(`/evals/runs/${run.id}`) },
      })
    } catch (err) {
      toast({
        tone: 'error',
        title: "Couldn't start scoring",
        description: err instanceof ApiError && err.status === 403 ? 'Your role cannot start a scoring run (viewers may only read results).' : errorText(err, 'Try again.'),
      })
    } finally {
      setStarting(false)
    }
  }

  const startButton = (
    <Button variant="primary" icon={<Play size={14} weight="fill" />} onClick={() => void startScoring()} loading={starting} disabled={!canRunEvals} title={runReason}>
      Score my sessions
    </Button>
  )

  const clearFilters = () => clearParams(RUN_FILTER_KEYS)
  const filtersActive = hasEvalRunFilters({ q, status })

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Evals"
        description="An LLM judge scores your chat runs; your thumbs up and down calibrate it. The offline suite lives in its own tab."
        actions={startButton}
        toolbar={
          <>
            <Segmented
              label="Evals sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'overview', label: 'Overview' },
                { value: 'runs', label: 'Scoring runs', count: runs?.length },
                { value: 'offline', label: 'Offline suite' },
              ]}
            />
            {tab === 'runs' && (
              <>
                <SearchInput label="Search scoring runs" placeholder="Search id, scope or judge" value={q} onValueChange={setQ} className="w-full sm:w-64" />
                <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {EVAL_RUN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
                {filtersActive && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </>
            )}
          </>
        }
      />

      {tab === 'overview' && <OverviewTab onGoToRuns={() => setTab('runs')} />}
      {tab === 'runs' && (
        <EvalRunsTab
          runs={runs}
          error={runsError}
          q={q}
          status={status}
          sortRaw={sortRaw}
          setSortRaw={setSortRaw}
          onClearFilters={clearFilters}
          onReload={reloadRuns}
          startAction={startButton}
        />
      )}
      {tab === 'offline' && <OfflineSuiteTab />}
    </div>
  )
}
