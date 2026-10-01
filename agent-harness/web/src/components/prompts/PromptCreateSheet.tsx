import { Seal } from '@phosphor-icons/react'
import { useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { PromptDetail, PromptKind, PromptVerification } from '../../lib/api-types'
import { PROMPT_KIND_LABELS, PROMPT_KINDS, validatePromptDraft } from '../../lib/prompts-list'
import { Button, ErrorBanner, Field, Input, Select, Sheet, Textarea } from '../ui'
import { DiscardFooter } from './DiscardFooter'
import { VerificationPanel } from './VerificationPanel'

type FieldName = 'slug' | 'name' | 'content'

/** Create a prompt: slug, name, kind, visibility and its first version. The
 * first version can be linted before saving. Closing with typed text asks
 * "Discard changes?" first. */
export function PromptCreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (created: PromptDetail) => void }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<PromptKind>('system')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [content, setContent] = useState('')
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verification, setVerification] = useState<PromptVerification | null>(null)
  const [askDiscard, setAskDiscard] = useState(false)

  const errors = validatePromptDraft({ slug, name, content })
  const shown = (field: FieldName) => (touched.has(field) ? errors[field] : null)
  const touch = (field: FieldName) => setTouched((prev) => new Set(prev).add(field))
  const dirty = !!(slug || name || description || content)

  const requestClose = () => (dirty ? setAskDiscard(true) : onClose())

  const verify = async () => {
    if (!content.trim()) {
      touch('content')
      return
    }
    setVerifying(true)
    setError(null)
    try {
      setVerification(await api.verifyPromptDraft({ content, kind }))
    } catch (err) {
      setError(errorText(err, 'Failed to verify the draft.'))
    } finally {
      setVerifying(false)
    }
  }

  const submit = async () => {
    if (errors.slug || errors.name || errors.content) {
      setTouched(new Set<FieldName>(['slug', 'name', 'content']))
      return
    }
    setCreating(true)
    setError(null)
    try {
      onCreated(
        await api.createPrompt({
          slug: slug.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          kind,
          visibility,
          content: content.trim(),
        }),
      )
    } catch (err) {
      setError(errorText(err, 'Failed to create the prompt.'))
      // A failed lint gate returns the verification: show which rule tripped.
      const failed = (err as { detail?: { verification?: PromptVerification } } | null)?.detail?.verification
      if (failed) setVerification(failed)
      setCreating(false)
    }
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      width="lg"
      eyebrow="Prompts"
      title="New prompt"
      footer={
        askDiscard ? (
          <DiscardFooter onKeep={() => setAskDiscard(false)} onDiscard={onClose} />
        ) : (
          <>
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={() => void submit()}>
              {creating ? 'Creating' : 'Create prompt'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Slug" error={shown('slug')} hint="Lowercase, kebab-case. The stable handle agents use.">
            {({ id, ...aria }) => <Input id={id} {...aria} name="slug" autoComplete="off" value={slug} onChange={(e) => setSlug(e.target.value)} onBlur={() => touch('slug')} placeholder="my-new-prompt" className="w-full font-data" />}
          </Field>
          <Field label="Name" error={shown('name')}>
            {({ id, ...aria }) => <Input id={id} {...aria} name="name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => touch('name')} placeholder="Ops assistant system prompt" className="w-full" />}
          </Field>
          <Field label="Kind">
            {({ id }) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as PromptKind)} className="w-full">
                {PROMPT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PROMPT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Visibility">
            {({ id }) => (
              <Select id={id} value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')} className="w-full">
                <option value="private">Private (only me and admins)</option>
                <option value="shared">Shared (everyone can read)</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description" optional>
          {({ id, ...aria }) => <Input id={id} {...aria} name="description" autoComplete="off" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full" />}
        </Field>
        <Field label="Initial content (v1)" error={shown('content')}>
          {({ id, ...aria }) => (
            <Textarea
              id={id}
              {...aria}
              name="content"
              autoComplete="off"
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setVerification(null)
              }}
              onBlur={() => touch('content')}
              rows={10}
              className="w-full font-data text-[13px]"
            />
          )}
        </Field>
        <div>
          <Button icon={<Seal size={14} weight="bold" />} loading={verifying} disabled={!content.trim()} onClick={() => void verify()}>
            {verifying ? 'Verifying' : 'Verify'}
          </Button>
        </div>
        {verification && (
          <div className="rounded-[10px] border border-[var(--color-line)] bg-zinc-50 p-3">
            <VerificationPanel verification={verification} />
          </div>
        )}
      </div>
    </Sheet>
  )
}
