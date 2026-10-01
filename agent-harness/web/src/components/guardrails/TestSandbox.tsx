import { CheckCircle, MinusCircle, Play, Prohibit, WarningCircle } from '@phosphor-icons/react'
import { useId, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ApiError, api } from '../../lib/api'
import type { Guardrail, GuardrailRuleCheck, GuardrailTestResult } from '../../lib/api-types'
import { checkStatus, kindLabel, splitHighlight, summarizeVerdict } from '../../lib/guardrail-sandbox'
import type { CheckStatus, VerdictTone } from '../../lib/guardrail-sandbox'

const MAX_TEXT = 4000
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const STATUSES = ['operational', 'degraded', 'down'] as const

const CHIP: Record<CheckStatus, { label: string; cls: string; icon: typeof CheckCircle }> = {
  fired: { label: 'Fired', cls: 'bg-rose-50 text-rose-800 ring-rose-200', icon: Prohibit },
  clear: { label: 'Did not fire', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200', icon: CheckCircle },
  disabled: { label: 'Disabled', cls: 'bg-zinc-100 text-zinc-700 ring-zinc-300', icon: MinusCircle },
}

const VERDICT: Record<VerdictTone, { cls: string; icon: typeof CheckCircle }> = {
  blocked: { cls: 'border-rose-300 bg-rose-50 text-rose-900', icon: Prohibit },
  downgraded: { cls: 'border-amber-300 bg-amber-50 text-amber-900', icon: WarningCircle },
  clear: { cls: 'border-emerald-300 bg-emerald-50 text-emerald-900', icon: CheckCircle },
}

interface Example {
  key: string
  label: string
  text?: string
  severity?: string
  status?: string
}

/** Example chips come only from the rules actually configured. */
function buildExamples(guardrails: Guardrail[]): Example[] {
  const examples: Example[] = []
  const seen = new Set<string>()
  for (const g of guardrails) {
    if (!g.enabled || g.kind !== 'objective_pattern_block') continue
    const patterns = Array.isArray(g.config.patterns) ? (g.config.patterns as unknown[]) : []
    const first = patterns.find((p): p is string => typeof p === 'string' && p.trim() !== '')
    if (first && !seen.has(first.toLowerCase()) && examples.length < 2) {
      seen.add(first.toLowerCase())
      examples.push({ key: `p-${g.id}`, label: first, text: first })
    }
  }
  if (guardrails.some((g) => g.enabled && g.kind === 'severity_upgrade_block')) {
    examples.push({
      key: 'sev',
      label: 'critical severity, service not down',
      severity: 'critical',
      status: 'operational',
    })
  }
  return examples
}

function StatusChip({ status }: { status: CheckStatus }) {
  const { label, cls, icon: Icon } = CHIP[status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      <Icon size={12} weight="fill" aria-hidden="true" />
      {label}
    </span>
  )
}

function CheckRow({ check, testedText }: { check: GuardrailRuleCheck; testedText: string }) {
  const status = checkStatus(check)
  const parts = splitHighlight(testedText, check.matched_pattern)
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={status} />
        <span className="min-w-0 text-[13px] font-medium text-zinc-900 [overflow-wrap:anywhere]">{check.name}</span>
        <span className="text-xs text-zinc-600">{kindLabel(check.kind)}</span>
      </div>
      <p className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{check.reason}</p>
      {check.matched_pattern && (
        <p className="max-h-24 overflow-auto rounded-md bg-zinc-50 px-2 py-1.5 font-data text-xs whitespace-pre-wrap text-zinc-700 ring-1 ring-zinc-200 [overflow-wrap:anywhere]">
          {parts.found ? (
            <>
              {parts.before}
              <mark className="rounded-sm bg-amber-200 px-0.5 font-semibold text-zinc-900">{parts.match}</mark>
              {parts.after}
            </>
          ) : (
            <>
              matched pattern: <mark className="rounded-sm bg-amber-200 px-0.5 text-zinc-900">{check.matched_pattern}</mark>
            </>
          )}
        </p>
      )}
    </li>
  )
}

/** Dry-run the typed text against every configured rule via the same logic the
 * agent loop enforces. Nothing is run or persisted. Tests on click only. */
export function TestSandbox({ guardrails }: { guardrails: Guardrail[] | null }) {
  const uid = useId()
  const [text, setText] = useState('')
  const [severity, setSeverity] = useState('')
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ result: GuardrailTestResult; testedText: string } | null>(null)

  const examples = useMemo(() => buildExamples(guardrails ?? []), [guardrails])
  const canTest = text.trim().length > 0 && !testing

  const run = async () => {
    if (!canTest) return
    setTesting(true)
    setError(null)
    try {
      const result = await api.testGuardrails({
        text,
        ...(severity ? { severity } : {}),
        ...(severity && status ? { evidence_status: status } : {}),
      })
      setOutcome({ result, testedText: text })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the test. Try again.')
    } finally {
      setTesting(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void run()
    }
  }

  const applyExample = (ex: Example) => {
    if (ex.text !== undefined) setText(ex.text)
    if (ex.severity) setSeverity(ex.severity)
    if (ex.status) setStatus(ex.status)
  }

  const verdict = outcome ? summarizeVerdict(outcome.result) : null
  const VerdictIcon = verdict ? VERDICT[verdict.tone].icon : null

  return (
    <section aria-labelledby={`${uid}-title`} className="ui-card p-4">
      <h2 id={`${uid}-title`} className="text-sm font-semibold text-zinc-900">
        Test sandbox
      </h2>
      <p className="mt-0.5 text-xs text-zinc-600">
        Checks your text against every rule exactly as a run would. Nothing is run or saved.
      </p>

      <label htmlFor={`${uid}-text`} className="mt-3 mb-1 block text-xs font-medium text-zinc-700">
        Type an objective to test
      </label>
      <textarea
        id={`${uid}-text`}
        name="sandbox-objective"
        autoComplete="off"
        spellCheck={false}
        rows={3}
        maxLength={MAX_TEXT}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="e.g. an objective an operator might submit…"
        className="ui-input w-full"
      />
      <div className="mt-1 flex justify-between text-xs text-zinc-600 tabular-nums">
        <span>Ctrl/Cmd+Enter to test</span>
        <span>
          {text.length} / {MAX_TEXT}
        </span>
      </div>

      <fieldset className="mt-3 flex flex-wrap items-end gap-3 border-0 p-0">
        <legend className="mb-1 text-xs font-medium text-zinc-700">Also test an incident severity (optional)</legend>
        <div>
          <label htmlFor={`${uid}-sev`} className="mb-1 block text-xs text-zinc-600">
            Severity
          </label>
          <select
            id={`${uid}-sev`}
            name="sandbox-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="ui-input w-36"
          >
            <option value="">None</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {severity && (
          <div>
            <label htmlFor={`${uid}-status`} className="mb-1 block text-xs text-zinc-600">
              Last service status seen
            </label>
            <select
              id={`${uid}-status`}
              name="sandbox-evidence-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="ui-input w-44"
            >
              <option value="">None yet</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="ui-btn ui-btn-primary" disabled={!canTest} onClick={() => void run()}>
          <Play size={14} weight="fill" aria-hidden="true" />
          {testing ? 'Testing…' : 'Test'}
        </button>
        {examples.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-600">Try:</span>
            {examples.map((ex) => (
              <button
                key={ex.key}
                type="button"
                onClick={() => applyExample(ex)}
                title={ex.text ? 'Fill the text box with this banned pattern' : 'Fill the severity fields'}
                className="ui-btn ui-btn-secondary ui-btn-sm max-w-64"
              >
                <span className="truncate">{ex.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4" aria-live="polite">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[13px] text-rose-800">
            <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-600" aria-hidden="true" />
            <p className="[overflow-wrap:anywhere]">{error}</p>
          </div>
        )}
        {outcome && verdict && VerdictIcon ? (
          <div>
            <p className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium ${VERDICT[verdict.tone].cls}`}>
              <VerdictIcon size={16} weight="fill" aria-hidden="true" />
              {verdict.headline}
            </p>
            {outcome.result.checks.length > 0 ? (
              <ul className="mt-2 divide-y divide-zinc-200 rounded-md border border-zinc-200">
                {outcome.result.checks.map((check) => (
                  <CheckRow key={check.guardrail_id} check={check} testedText={outcome.testedText} />
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-zinc-600">No rules are configured, so nothing can fire.</p>
            )}
          </div>
        ) : (
          !error && (
            <p className="rounded-md border border-dashed border-zinc-300 px-3 py-4 text-center text-[13px] text-zinc-600">
              Results appear here: one row per rule, showing whether it fired and why.
            </p>
          )
        )}
      </div>
    </section>
  )
}
