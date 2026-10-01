import { useId, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { Guardrail } from '../../lib/api-types'
import { parsePatterns, validateGuardrailName, validatePatterns } from '../../lib/guardrails-validation'
import { Button, Field, Input, Sheet, SheetSection, Textarea, useToast } from '../ui'
import { DiscardFooter } from './DiscardFooter'

/** Create an input guardrail (banned objective patterns). Validates on blur,
 * asks before discarding edits, and toasts with Open on success (the API has
 * no delete, so there is nothing to undo). */
export function CreateRuleSheet({ canMutate, reason, onClose, onCreated }: { canMutate: boolean; reason?: string; onClose: () => void; onCreated: (created: Guardrail) => void }) {
  const formId = useId()
  const toast = useToast()
  const [name, setName] = useState('')
  const [patterns, setPatterns] = useState('')
  const [touched, setTouched] = useState({ name: false, patterns: false })
  const [saving, setSaving] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const nameError = validateGuardrailName(name)
  const patternsError = validatePatterns(patterns)
  const dirty = name.trim() !== '' || patterns.trim() !== ''
  const requestClose = () => (dirty && !saving ? setConfirmClose(true) : onClose())

  const submit = async () => {
    setTouched({ name: true, patterns: true })
    if (!canMutate || nameError || patternsError) return
    setSaving(true)
    try {
      const created = await api.createGuardrail({ name: name.trim(), kind: 'objective_pattern_block', config: { patterns: parsePatterns(patterns) } })
      onCreated(created)
      toast({ title: `Created “${created.name}”`, description: 'It is enforced from the next run.' })
      onClose()
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't create the guardrail", description: errorText(err, 'Try again.') })
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      eyebrow="Guardrails"
      title="New guardrail"
      meta={<span>Blocks objectives that match a banned pattern before the agent starts.</span>}
      footer={
        confirmClose ? (
          <DiscardFooter onKeep={() => setConfirmClose(false)} onDiscard={onClose} />
        ) : (
          <>
            {!canMutate && <span className="mr-auto text-xs text-zinc-600">{reason}</span>}
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={saving} disabled={!canMutate} title={reason}>
              Create guardrail
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <SheetSection title="Rule">
          <div className="space-y-4">
            <Field label="Name" error={touched.name ? nameError : null}>
              {(p) => (
                <Input
                  {...p}
                  name="guardrail-name"
                  autoComplete="off"
                  value={name}
                  disabled={!canMutate}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="e.g. Block destructive requests…"
                  className="w-full"
                />
              )}
            </Field>
            <Field label="Banned patterns" hint="One per line. Matching ignores case; a run whose objective contains one is blocked." error={touched.patterns ? patternsError : null}>
              {(p) => (
                <Textarea
                  {...p}
                  name="guardrail-patterns"
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                  value={patterns}
                  disabled={!canMutate}
                  onChange={(e) => setPatterns(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, patterns: true }))}
                  placeholder={'delete all data\nwipe the database'}
                  className="font-data w-full"
                />
              )}
            </Field>
          </div>
        </SheetSection>
      </form>
    </Sheet>
  )
}
