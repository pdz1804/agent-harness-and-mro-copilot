import { useEffect, useState } from 'react'
import { errorText } from '../../lib/api'
import { MAX_FACT_LENGTH, MAX_TAGS, formatTags, parseTags, validateFact } from '../../lib/memory-tags'
import { Field, Input, Textarea } from '../ui'

export const MEMORY_FORM_ID = 'memory-editor-form'

interface MemoryEditorProps {
  initialFact?: string
  initialTags?: string[]
  onSubmit: (fact: string, tags: string[]) => Promise<void>
  /** The sheet footer owns the buttons, so it needs to know both states. */
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void
  autoFocus?: boolean
}

/** Fact + tags form shared by "Remember a fact" and editing an existing
 * memory. It renders no buttons: the sheet footer submits it through
 * `MEMORY_FORM_ID`. Validation shows on blur and on submit. */
export function MemoryEditor({ initialFact = '', initialTags = [], onSubmit, onStateChange, autoFocus = false }: MemoryEditorProps) {
  const [fact, setFact] = useState(initialFact)
  const [tagsText, setTagsText] = useState(formatTags(initialTags))
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const factError = validateFact(fact)
  const parsedTags = parseTags(tagsText)
  const dirty = fact !== initialFact || formatTags(parsedTags) !== formatTags(initialTags)

  useEffect(() => {
    onStateChange({ dirty, saving })
  }, [dirty, saving, onStateChange])

  const submit = async () => {
    setTouched(true)
    if (factError || saving) return
    setSaving(true)
    setServerError(null)
    try {
      await onSubmit(fact.trim(), parsedTags)
    } catch (err: unknown) {
      setServerError(errorText(err, 'Could not save the memory. Check the connection and try again.'))
      setSaving(false)
    }
  }

  return (
    <form
      id={MEMORY_FORM_ID}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Field
        label="Fact"
        error={touched ? factError : null}
        hint={
          <span className="flex items-start justify-between gap-3">
            <span>One self-contained statement the agent can recall later.</span>
            <span className="font-data shrink-0 tabular-nums">
              {fact.length}/{MAX_FACT_LENGTH}
            </span>
          </span>
        }
      >
        {(field) => (
          <Textarea
            {...field}
            name="fact"
            autoComplete="off"
            rows={4}
            maxLength={MAX_FACT_LENGTH}
            autoFocus={autoFocus}
            value={fact}
            onChange={(e) => setFact(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. The on-call rota rotates every Monday at 09:00 ICT"
            className="w-full"
          />
        )}
      </Field>
      <Field label="Tags" optional hint={`Comma separated. Up to ${MAX_TAGS} tags, lower-cased and de-duplicated: ${parsedTags.length} parsed.`}>
        {(field) => <Input {...field} name="tags" type="text" autoComplete="off" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="oncall, rota" className="w-full" />}
      </Field>
      {serverError && (
        <p role="alert" className="text-xs text-rose-700 [overflow-wrap:anywhere]">
          {serverError}
        </p>
      )}
    </form>
  )
}
