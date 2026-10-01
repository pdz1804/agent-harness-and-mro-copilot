import { CheckCircle, MinusCircle, Play, Prohibit, WarningCircle } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { api, errorText } from '../../lib/api'
import type { Guardrail, GuardrailRuleCheck, GuardrailTestResult } from '../../lib/api-types'
import { checkStatus, kindLabel, splitHighlight, summarizeVerdict } from '../../lib/guardrail-sandbox'
import type { CheckStatus, VerdictTone } from '../../lib/guardrail-sandbox'
import { Button, Card, CardHeader, Chip, Field, Select, Textarea, type ChipTone } from '../ui'

const MAX_TEXT = 4000
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const STATUSES = ['operational', 'degraded', 'down'] as const

const CHIP: Record<CheckStatus, { label: string; tone: ChipTone; icon: typeof CheckCircle }> = {
  fired: { label: 'Fired', tone: 'danger', icon: Prohibit },
  clear: { label: 'Did not fire', tone: 'ok', icon: CheckCircle },
  disabled: { label: 'Disabled', tone: 'muted', icon: MinusCircle },
}

const VERDICT: Record<VerdictTone, { cls: string; icon: typeof CheckCircle }> = {
  blocked: { cls: 'bg-rose-50 text-rose-900 ring-rose-200', icon: Prohibit },
  downgraded: { cls: 'bg-amber-50 text-amber-900 ring-amber-200', icon: WarningCircle },
  clear: { cls: 'bg-emerald-50 text-emerald-900 ring-emerald-200', icon: CheckCircle },
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
    examples.push({ key: 'sev', label: 'critical severity, service not down', severity: 'critical', status: 'operational' })
  }
  return examples
}

function CheckRow({ check, testedText }: { check: GuardrailRuleCheck; testedText: string }) {
  const status = checkStatus(check)
  const { label, tone, icon: Icon } = CHIP[status]
  const parts = splitHighlight(testedText, check.matched_pattern)
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={tone} icon={<Icon size={12} weight="fill" aria-hidden="true" />}>
          {label}
        </Chip>
        <span className="min-w-0 text-[13px] font-medium text-zinc-900 [overflow-wrap:anywhere]">{check.name}</span>
        <span className="text-xs text-zinc-600">{kindLabel(check.kind)}</span>
      </div>
      <p className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{check.reason}</p>
      {check.matched_pattern && (
        <p className="font-data max-h-24 overflow-auto rounded-[10px] bg-zinc-950/[0.04] px-2 py-1.5 text-xs whitespace-pre-wrap text-zinc-700 [overflow-wrap:anywhere]">
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
      setError(errorText(err, 'Could not run the test. Try again.'))
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
    <Card as="section" aria-label="Test sandbox">
      <CardHeader title="Test sandbox" meta="Checks your text against every rule exactly as a run would. Nothing is run or saved." />

      <div className="mt-3 space-y-3">
        <Field label="Type an objective to test" hint={`Ctrl/Cmd+Enter to test · ${text.length} / ${MAX_TEXT}`}>
          {(p) => (
            <Textarea
              {...p}
              name="sandbox-objective"
              autoComplete="off"
              spellCheck={false}
              rows={3}
              maxLength={MAX_TEXT}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="e.g. an objective an operator might submit…"
              className="w-full"
            />
          )}
        </Field>

        <fieldset className="flex flex-wrap items-end gap-3 border-0 p-0">
          <legend className="mb-1.5 text-[13px] font-medium text-zinc-800">Also test an incident severity (optional)</legend>
          <Field label="Severity" className="w-36">
            {(p) => (
              <Select id={p.id} aria-describedby={p['aria-describedby']} name="sandbox-severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full">
                <option value="">None</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {severity && (
            <Field label="Last service status seen" className="w-44">
              {(p) => (
                <Select id={p.id} aria-describedby={p['aria-describedby']} name="sandbox-evidence-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full">
                  <option value="">None yet</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={text.trim().length === 0} loading={testing} onClick={() => void run()} icon={<Play size={14} weight="fill" aria-hidden="true" />}>
            Test
          </Button>
          {examples.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-600">Try:</span>
              {examples.map((ex) => (
                <Button key={ex.key} size="sm" className="max-w-64" onClick={() => applyExample(ex)} title={ex.text ? 'Fill the text box with this banned pattern' : 'Fill the severity fields'}>
                  <span className="truncate">{ex.label}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4" aria-live="polite">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-[10px] bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-rose-200 ring-inset">
            <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-600" aria-hidden="true" />
            <p className="[overflow-wrap:anywhere]">{error}</p>
          </div>
        )}
        {outcome && verdict && VerdictIcon ? (
          <div>
            <p className={`flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-medium ring-1 ring-inset ${VERDICT[verdict.tone].cls}`}>
              <VerdictIcon size={16} weight="fill" aria-hidden="true" />
              {verdict.headline}
            </p>
            {outcome.result.checks.length > 0 ? (
              <ul className="mt-2 divide-y divide-[var(--color-line)] rounded-[10px] ring-1 ring-[var(--color-line)]">
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
            <p className="rounded-[10px] border border-dashed border-[var(--color-line-strong)] px-3 py-4 text-center text-[13px] text-zinc-600">
              Results appear here: one row per rule, showing whether it fired and why.
            </p>
          )
        )}
      </div>
    </Card>
  )
}
