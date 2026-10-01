import { useMemo, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { Skill, ToolCatalogEntry } from '../../lib/api-types'
import { EMPTY_SKILL_FORM, hasErrors, isSkillFormDirty, parseExamples, skillToForm, validateSkillForm, type SkillFormState } from '../../lib/skills-form'
import { DiscardFooter } from '../prompts/DiscardFooter'
import { Button, ErrorBanner, Field, Input, Select, Sheet, Switch, Textarea } from '../ui'
import { ToolPicker } from '../ui/ToolPicker'

type FieldName = 'slug' | 'name' | 'description' | 'allowed_tools'

interface SkillFormSheetProps {
  /** The skill being edited, or null to create one. */
  skill: Skill | null
  tools: ToolCatalogEntry[]
  canWrite: boolean
  writeReason: string
  onClose: () => void
  /** Called after the API accepted the change; `previous` is the skill before an edit (for Undo). */
  onSaved: (saved: Skill, previous: Skill | null) => void
}

/** Create or edit a skill. Fields validate on blur; closing with changes asks
 * "Discard changes?"; a read-only role sees every field disabled with the reason. */
export function SkillFormSheet({ skill, tools, canWrite, writeReason, onClose, onSaved }: SkillFormSheetProps) {
  const isNew = skill === null
  const initial = useMemo(() => (skill ? skillToForm(skill) : EMPTY_SKILL_FORM), [skill])
  const [form, setForm] = useState<SkillFormState>(initial)
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askDiscard, setAskDiscard] = useState(false)

  const errors = validateSkillForm(form, isNew)
  const shown = (field: FieldName) => (touched.has(field) ? errors[field] : null)
  const touch = (field: FieldName) => setTouched((prev) => new Set(prev).add(field))
  const set = <K extends keyof SkillFormState>(key: K, value: SkillFormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const dirty = isSkillFormDirty(form, initial)
  const requestClose = () => (dirty ? setAskDiscard(true) : onClose())

  const save = async () => {
    if (hasErrors(errors)) {
      setTouched(new Set<FieldName>(['slug', 'name', 'description', 'allowed_tools']))
      return
    }
    setSaving(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
      allowed_tools: form.allowed_tools,
      examples: parseExamples(form.examples),
      visibility: form.visibility,
      enabled: form.enabled,
    }
    try {
      const saved = skill ? await api.updateSkill(skill.id, body) : await api.createSkill({ slug: form.slug.trim(), ...body })
      onSaved(saved, skill)
    } catch (err) {
      setError(errorText(err, 'Failed to save the skill.'))
      setSaving(false)
    }
  }

  const disabled = !canWrite
  return (
    <Sheet
      open
      onClose={requestClose}
      width="lg"
      eyebrow="Skills"
      title={isNew ? 'New skill' : `Edit ${skill.name}`}
      label={isNew ? 'New skill' : `Edit ${skill.name}`}
      footer={
        askDiscard ? (
          <DiscardFooter onKeep={() => setAskDiscard(false)} onDiscard={onClose} />
        ) : (
          <>
            {!canWrite && <span className="mr-auto text-xs text-zinc-500">{writeReason}</span>}
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!canWrite} title={canWrite ? undefined : writeReason} onClick={() => void save()}>
              {saving ? 'Saving' : isNew ? 'Create skill' : 'Save changes'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        {!canWrite && !isNew && <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">You can view this skill but not edit it. {writeReason}</p>}

        {isNew && (
          <Field label="Slug" error={shown('slug')} hint="Lowercase, kebab-case. It becomes the /slug command in chat.">
            {({ id, ...aria }) => <Input id={id} {...aria} name="slug" autoComplete="off" value={form.slug} onChange={(e) => set('slug', e.target.value)} onBlur={() => touch('slug')} placeholder="triage-outage" className="w-full font-data" />}
          </Field>
        )}

        <Field label="Name" error={shown('name')}>
          {({ id, ...aria }) => <Input id={id} {...aria} name="name" autoComplete="off" value={form.name} disabled={disabled} onChange={(e) => set('name', e.target.value)} onBlur={() => touch('name')} className="w-full" />}
        </Field>

        <Field label="Description (routing signal)" error={shown('description')} hint="The skill router reads this to decide when the skill applies.">
          {({ id, ...aria }) => <Textarea id={id} {...aria} name="description" autoComplete="off" value={form.description} disabled={disabled} onChange={(e) => set('description', e.target.value)} onBlur={() => touch('description')} rows={2} className="w-full" />}
        </Field>

        <Field label="Instructions" optional hint="Markdown, appended to the system prompt when the skill is active.">
          {({ id, ...aria }) => <Textarea id={id} {...aria} name="instructions" autoComplete="off" value={form.instructions} disabled={disabled} onChange={(e) => set('instructions', e.target.value)} rows={6} className="w-full font-data text-[13px]" />}
        </Field>

        <div className="space-y-1.5">
          <p className="text-[13px] font-medium text-zinc-800">Allowed tools</p>
          <div onBlur={() => touch('allowed_tools')}>
            <ToolPicker tools={tools} selected={form.allowed_tools} onChange={(next) => canWrite && set('allowed_tools', next)} />
          </div>
          {shown('allowed_tools') && <p className="text-xs text-rose-700">{errors.allowed_tools}</p>}
        </div>

        <Field label="Examples" optional hint="One per line: sample user intents. The routing tester offers them as shortcuts.">
          {({ id, ...aria }) => (
            <Textarea id={id} {...aria} name="examples" autoComplete="off" value={form.examples} disabled={disabled} onChange={(e) => set('examples', e.target.value)} rows={3} placeholder={'auth-service is returning errors\nwhy is checkout down'} className="w-full" />
          )}
        </Field>

        <div className="flex flex-wrap items-end gap-6">
          <Field label="Visibility" className="min-w-40">
            {({ id }) => (
              <Select id={id} value={form.visibility} disabled={disabled} onChange={(e) => set('visibility', e.target.value as 'private' | 'shared')} className="w-full">
                <option value="private">Private</option>
                <option value="shared">Shared</option>
              </Select>
            )}
          </Field>
          <span className="flex items-center gap-2 pb-1.5 text-[13px] text-zinc-800">
            <Switch label="Enabled" checked={form.enabled} onChange={(next) => set('enabled', next)} disabled={disabled} title={canWrite ? undefined : writeReason} />
            Enabled
          </span>
        </div>
      </div>
    </Sheet>
  )
}
