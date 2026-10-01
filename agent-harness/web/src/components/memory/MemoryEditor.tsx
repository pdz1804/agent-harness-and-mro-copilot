import { useState } from 'react'
import { ApiError } from '../../lib/api'
import { MAX_FACT_LENGTH, MAX_TAGS, formatTags, parseTags, validateFact } from '../../lib/memory-tags'

interface MemoryEditorProps {
  /** Unique per editor instance so labels bind to the right controls. */
  idPrefix: string
  initialFact?: string
  initialTags?: string[]
  submitLabel: string
  onSubmit: (fact: string, tags: string[]) => Promise<void>
  onCancel: () => void
  autoFocus?: boolean
}

/** Fact + tags form shared by "Add memory" and the inline row edit. */
export function MemoryEditor({
  idPrefix,
  initialFact = '',
  initialTags = [],
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = false,
}: MemoryEditorProps) {
  const [fact, setFact] = useState(initialFact)
  const [tagsText, setTagsText] = useState(formatTags(initialTags))
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const factError = validateFact(fact)
  const shownError = touched ? factError : null
  const factId = `${idPrefix}-fact`
  const tagsId = `${idPrefix}-tags`

  const submit = async () => {
    setTouched(true)
    if (factError || saving) return
    setSaving(true)
    setServerError(null)
    try {
      await onSubmit(fact.trim(), parseTags(tagsText))
    } catch (err: unknown) {
      setServerError(err instanceof ApiError ? err.message : 'Could not save the memory. Check the connection and try again.')
      setSaving(false)
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div>
        <label htmlFor={factId} className="ui-section-label mb-1 block">
          Fact
        </label>
        <textarea
          id={factId}
          name="fact"
          autoComplete="off"
          rows={3}
          maxLength={MAX_FACT_LENGTH}
          autoFocus={autoFocus}
          value={fact}
          onChange={(e) => setFact(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={`${factId}-help`}
          placeholder="e.g. The on-call rota rotates every Monday at 09:00 ICT…"
          className="ui-input w-full"
        />
        <div id={`${factId}-help`} className="mt-1 flex items-start justify-between gap-3 text-xs">
          <span className={shownError ? 'text-rose-700' : 'text-zinc-600'}>
            {shownError ?? 'One self-contained statement the agent can recall later.'}
          </span>
          <span className="font-data shrink-0 text-zinc-600 tabular-nums">
            {fact.length}/{MAX_FACT_LENGTH}
          </span>
        </div>
      </div>
      <div>
        <label htmlFor={tagsId} className="ui-section-label mb-1 block">
          Tags
        </label>
        <input
          id={tagsId}
          name="tags"
          type="text"
          autoComplete="off"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="comma, separated, tags…"
          className="ui-input w-full"
        />
        <p className="mt-1 text-xs text-zinc-600">
          Optional. Up to {MAX_TAGS} tags, lower-cased and de-duplicated: {parseTags(tagsText).length} parsed.
        </p>
      </div>
      {serverError && (
        <p role="alert" className="text-xs text-rose-700 [overflow-wrap:anywhere]">
          {serverError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="ui-btn ui-btn-secondary ui-btn-sm">
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="ui-btn ui-btn-ghost ui-btn-sm">
          Cancel
        </button>
      </div>
    </form>
  )
}
