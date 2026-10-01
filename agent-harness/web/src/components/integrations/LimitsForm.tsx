import { useEffect, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { Integration, IntegrationDetail } from '../../lib/api-types'
import { RETRIES_MAX, RETRIES_MIN, TIMEOUT_MAX, TIMEOUT_MIN, describeLimit, parseRetries, parseTimeout } from '../../lib/integration-limits'
import { describeLimits, limitsToText, sameLimits, type LimitsValue } from '../../lib/integrations-filter'
import { Button, Field, FactList, Input, useToast } from '../ui'

export interface LimitsFormStatus {
  /** The inputs differ from the saved limits (guards closing the sheet). */
  dirty: boolean
  /** Valid, changed and not mid-save: the footer Save is enabled. */
  canSave: boolean
  saving: boolean
}

interface LimitsFormProps {
  tool: string
  detail: IntegrationDetail
  canMutate: boolean
  /** Why editing is unavailable (non-admins), shown as visible text. */
  disabledTitle?: string
  /** DOM id of the `<form>`, so the sheet footer's Save button can submit it. */
  formId: string
  onSaved: (updated: Integration) => void
  onStatus: (status: LimitsFormStatus) => void
}

/** Effective timeout/retries plus, for roles that can edit, override inputs.
 * A blank input means "no override" (the global default): Save always sends
 * both fields, and a blank one is sent as null, which clears that override.
 * Inputs validate on blur. Every save toasts with Undo, which writes the
 * previous limits back. */
export function LimitsForm({ tool, detail, canMutate, disabledTitle, formId, onSaved, onStatus }: LimitsFormProps) {
  const toast = useToast()
  const [timeoutText, setTimeoutText] = useState(limitsToText(detail.timeout_seconds))
  const [retriesText, setRetriesText] = useState(limitsToText(detail.max_retries))
  const [baseline, setBaseline] = useState<LimitsValue>({ timeout_seconds: detail.timeout_seconds, max_retries: detail.max_retries })
  const [touched, setTouched] = useState({ timeout: false, retries: false })
  const [saving, setSaving] = useState<'save' | 'reset' | null>(null)

  const timeout = parseTimeout(timeoutText)
  const retries = parseRetries(retriesText)
  const valid = timeout.ok && retries.ok
  const dirty = valid ? !sameLimits({ timeout_seconds: timeout.value, max_retries: retries.value }, baseline) : timeoutText.trim() !== limitsToText(baseline.timeout_seconds) || retriesText.trim() !== limitsToText(baseline.max_retries)
  const canSave = canMutate && valid && dirty && saving === null
  const hasOverride = baseline.timeout_seconds !== null || baseline.max_retries !== null

  useEffect(() => {
    onStatus({ dirty, canSave, saving: saving !== null })
  }, [dirty, canSave, saving, onStatus])

  const apply = (updated: Integration) => {
    setTimeoutText(limitsToText(updated.timeout_seconds))
    setRetriesText(limitsToText(updated.max_retries))
    setBaseline({ timeout_seconds: updated.timeout_seconds, max_retries: updated.max_retries })
    setTouched({ timeout: false, retries: false })
    onSaved(updated)
  }

  const send = async (limits: LimitsValue, kind: 'save' | 'reset') => {
    const previous = baseline
    setSaving(kind)
    try {
      const updated = await api.updateIntegrationLimits(tool, limits)
      apply(updated)
      toast({
        title: kind === 'reset' ? `${tool}: limits reset to default` : `${tool}: ${describeLimits(limits)} saved`,
        description: 'Applies to new runs.',
        action: {
          label: 'Undo',
          run: async () => {
            apply(await api.updateIntegrationLimits(tool, previous))
          },
        },
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't save limits for ${tool}`, description: errorText(err, 'Try again.') })
    } finally {
      setSaving(null)
    }
  }

  const submit = () => {
    setTouched({ timeout: true, retries: true })
    if (!canSave || !timeout.ok || !retries.ok) return
    void send({ timeout_seconds: timeout.value, max_retries: retries.value }, 'save')
  }

  return (
    <div className="space-y-3">
      <FactList
        items={[
          { label: 'Effective timeout', value: <span className="font-medium tabular-nums">{describeLimit(detail.effective.timeout_seconds, detail.effective.timeout_overridden)}</span> },
          { label: 'Effective retries', value: <span className="font-medium tabular-nums">{describeLimit(detail.effective.max_retries, detail.effective.retries_overridden)}</span> },
        ]}
      />

      {canMutate ? (
        <form
          id={formId}
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Timeout (seconds)" optional error={touched.timeout && !timeout.ok ? timeout.error : null} hint={`${TIMEOUT_MIN} to ${TIMEOUT_MAX}. Blank uses the default.`}>
              {(p) => (
                <Input
                  {...p}
                  name="timeout-seconds"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={timeoutText}
                  onChange={(e) => setTimeoutText(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, timeout: true }))}
                  placeholder="Default…"
                  className="w-full tabular-nums"
                />
              )}
            </Field>
            <Field label="Max retries" optional error={touched.retries && !retries.ok ? retries.error : null} hint={`${RETRIES_MIN} to ${RETRIES_MAX}. Blank uses the default.`}>
              {(p) => (
                <Input
                  {...p}
                  name="max-retries"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={retriesText}
                  onChange={(e) => setRetriesText(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, retries: true }))}
                  placeholder="Default…"
                  className="w-full tabular-nums"
                />
              )}
            </Field>
          </div>
          <div className="mt-3">
            <Button size="sm" disabled={saving !== null || !hasOverride} loading={saving === 'reset'} onClick={() => void send({ timeout_seconds: null, max_retries: null }, 'reset')}>
              Reset to default
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-zinc-600" title={disabledTitle}>
          {disabledTitle ?? 'Read-only.'}
        </p>
      )}

      <p className="text-xs text-zinc-600">Limits apply to new runs only. Runs already in progress keep theirs.</p>
    </div>
  )
}
