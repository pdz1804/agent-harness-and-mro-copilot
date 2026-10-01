import { UploadSimple } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { api, errorText } from '../../lib/api'
import type { KBDocDetail } from '../../lib/api-types'
import { validateDocContent, validateFileSize } from '../../lib/kb-docs'
import { Button, ConfirmPanel, ErrorBanner, Field, Input, Sheet, Textarea } from '../ui'

const FORM_ID = 'kb-add-form'

/** Add a document to the knowledge base in a sheet: paste text or load a
 * .md/.txt file. The server chunks and indexes it immediately, so the agent's
 * search tool can find it on its next call. Closing with unsaved text asks
 * "Discard changes?" first. */
export function AddDocumentSheet({ onAdded, onClose }: { onAdded: (doc: KBDocDetail) => void; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [touched, setTouched] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const dirty = title.trim() !== '' || content.trim() !== ''
  const contentError = fileError ?? (touched ? validateDocContent(content) : null)

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmingDiscard(true)
    else onClose()
  }

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    const tooBig = validateFileSize(file.size)
    if (tooBig) {
      setFileError(tooBig)
      return
    }
    setFileError(null)
    try {
      setContent(await file.text())
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''))
    } catch (err) {
      setFileError(errorText(err, 'Could not read that file.'))
    }
  }

  const submit = async () => {
    setTouched(true)
    if (saving || validateDocContent(content)) return
    setSaving(true)
    setError(null)
    try {
      onAdded(await api.createKbDoc({ title: title.trim() || undefined, content }))
    } catch (err) {
      setError(errorText(err, 'Failed to add the document.'))
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      eyebrow="Knowledge / Documents"
      title="Add document"
      width="lg"
      footer={
        confirmingDiscard ? (
          <div className="w-full rounded-[14px] bg-white ring-1 ring-[var(--color-line)] [&>div]:w-full">
            <ConfirmPanel title="Discard changes?" description="What you typed will be lost." confirmLabel="Discard" onConfirm={onClose} onCancel={() => setConfirmingDiscard(false)} />
          </div>
        ) : (
          <>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={saving}>
              {saving ? 'Chunking and indexing' : 'Add and index'}
            </Button>
          </>
        )
      }
    >
      <form
        id={FORM_ID}
        data-testid="kb-add-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {error && <ErrorBanner message={error} />}
        <Field label="Title" optional hint="Defaults to the first heading in the content.">
          {(field) => <Input {...field} name="title" autoComplete="off" maxLength={200} className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Content" hint="Markdown or plain text. Paragraphs are merged into chunks of up to 800 characters." error={contentError}>
          {(field) => (
            <Textarea
              {...field}
              name="content"
              autoComplete="off"
              spellCheck={false}
              rows={12}
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setFileError(null)
              }}
              onBlur={() => setTouched(true)}
              placeholder={'# Runbook: …\n\nWhat to check first, then the steps to fix it.'}
              className="font-data w-full"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            name="file"
            aria-label="Choose a markdown or text file"
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            onChange={(e) => {
              void loadFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <Button size="sm" icon={<UploadSimple size={14} weight="bold" />} onClick={() => fileRef.current?.click()}>
            Load a .md or .txt file
          </Button>
          <span className="text-xs text-zinc-500 tabular-nums">{content.length.toLocaleString()} characters</span>
        </div>
      </form>
    </Sheet>
  )
}
