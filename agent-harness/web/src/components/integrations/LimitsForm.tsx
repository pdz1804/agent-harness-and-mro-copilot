import { useId, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { Integration, IntegrationDetail } from '../../lib/api-types'
import {
  RETRIES_MAX,
  RETRIES_MIN,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  describeLimit,
  parseRetries,
  parseTimeout,
} from '../../lib/integration-limits'

interface LimitsFormProps {
  tool: string
  detail: IntegrationDetail
  canMutate: boolean
  /** Tooltip explaining why editing is unavailable (non-admins). */
  disabledTitle?: string
  onSaved: (updated: Integration) => void
}

/** Effective timeout/retries plus, for admins, override inputs. A blank input
 * means "no override" (the global default): Save always sends both fields, and a
 * blank one is sent as null, which clears that override. After a save the inputs
 * are re-synced from the server's response. */
export function LimitsForm({ tool, detail, canMutate, disabledTitle, onSaved }: LimitsFormProps) {
  const uid = useId()
  const [timeoutText, setTimeoutText] = useState(detail.timeout_seconds === null ? '' : String(detail.timeout_seconds))
  const [retriesText, setRetriesText] = useState(detail.max_retries === null ? '' : String(detail.max_retries))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  const timeout = parseTimeout(timeoutText)
  const retries = parseRetries(retriesText)
  const unchanged =
    timeout.ok && retries.ok && timeout.value === detail.timeout_seconds && retries.value === detail.max_retries
  const hasOverride = detail.timeout_seconds !== null || detail.max_retries !== null

  const send = async (limits: { timeout_seconds: number | null; max_retries: number | null }) => {
    setSaving(true)
    setMessage(null)
    try {
      const updated = await api.updateIntegrationLimits(tool, limits)
      setTimeoutText(updated.timeout_seconds === null ? '' : String(updated.timeout_seconds))
      setRetriesText(updated.max_retries === null ? '' : String(updated.max_retries))
      setMessage({ kind: 'ok', text: 'Saved. New runs will use these limits.' })
      onSaved(updated)
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save the limits. Try again.' })
    } finally {
      setSaving(false)
    }
  }

  const save = () => {
    if (!timeout.ok || !retries.ok) return
    void send({ timeout_seconds: timeout.value, max_retries: retries.value })
  }

  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <dt className="text-xs text-zinc-600">Timeout (seconds)</dt>
          <dd className="font-medium text-zinc-900 tabular-nums">
            {describeLimit(detail.effective.timeout_seconds, detail.effective.timeout_overridden)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-600">Max retries</dt>
          <dd className="font-medium text-zinc-900 tabular-nums">
            {describeLimit(detail.effective.max_retries, detail.effective.retries_overridden)}
          </dd>
        </div>
      </dl>

      {canMutate ? (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div className="flex flex-wrap items-start gap-3">
            <div>
              <label htmlFor={`${uid}-timeout`} className="mb-1 block text-xs font-medium text-zinc-700">
                Timeout (seconds)
              </label>
              <input
                id={`${uid}-timeout`}
                name="timeout-seconds"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={timeoutText}
                onChange={(e) => setTimeoutText(e.target.value)}
                placeholder="default…"
                aria-invalid={!timeout.ok}
                aria-describedby={`${uid}-timeout-hint`}
                className="ui-input w-32 tabular-nums"
              />
              <p
                id={`${uid}-timeout-hint`}
                className={`mt-1 max-w-48 text-xs ${timeout.ok ? 'text-zinc-600' : 'text-rose-700'}`}
              >
                {timeout.ok ? `${TIMEOUT_MIN} to ${TIMEOUT_MAX}. Blank uses the default.` : timeout.error}
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-retries`} className="mb-1 block text-xs font-medium text-zinc-700">
                Max retries
              </label>
              <input
                id={`${uid}-retries`}
                name="max-retries"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={retriesText}
                onChange={(e) => setRetriesText(e.target.value)}
                placeholder="default…"
                aria-invalid={!retries.ok}
                aria-describedby={`${uid}-retries-hint`}
                className="ui-input w-32 tabular-nums"
              />
              <p
                id={`${uid}-retries-hint`}
                className={`mt-1 max-w-48 text-xs ${retries.ok ? 'text-zinc-600' : 'text-rose-700'}`}
              >
                {retries.ok ? `${RETRIES_MIN} to ${RETRIES_MAX}. Blank uses the default.` : retries.error}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="ui-btn ui-btn-primary ui-btn-sm"
              disabled={saving || !timeout.ok || !retries.ok || unchanged}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={saving || !hasOverride}
              onClick={() => void send({ timeout_seconds: null, max_retries: null })}
            >
              Reset to default
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-2 text-xs text-zinc-600" title={disabledTitle}>
          {disabledTitle ?? 'Read-only.'}
        </p>
      )}

      <p className="mt-2 text-xs text-zinc-600">Limits apply to new runs only. Runs already in progress keep theirs.</p>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`mt-1 text-xs [overflow-wrap:anywhere] ${message.kind === 'error' ? 'text-rose-700' : 'text-emerald-800'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
