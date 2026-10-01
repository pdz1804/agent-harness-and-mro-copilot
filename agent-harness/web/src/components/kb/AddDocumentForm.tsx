import { UploadSimple } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { KBDocDetail } from '../../lib/api-types'
import { ErrorBanner } from '../ErrorBanner'

const MAX_FILE_BYTES = 200_000

/** Add a document to the knowledge base: paste text or load a .md/.txt file.
 * The server chunks and indexes it immediately, so the agent's search tool
 * can find it on its next call. */
export function AddDocumentForm({
  onAdded,
  onCancel,
}: {
  onAdded: (doc: KBDocDetail) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${Math.round(file.size / 1000)} KB; the limit is ${MAX_FILE_BYTES / 1000} KB.`)
      return
    }
    setError(null)
    setContent(await file.text())
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''))
  }

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      onAdded(await api.createKbDoc({ title: title.trim() || undefined, content }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the document.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ui-card space-y-2.5 p-4" data-testid="kb-add-form">
      {error && <ErrorBanner message={error} />}
      <label className="block text-xs font-medium text-zinc-500">
        Title (optional — defaults to the first heading)
        <input
          name="title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
      </label>
      <label className="block text-xs font-medium text-zinc-500">
        Content (markdown or plain text)
        <textarea
          name="content"
          autoComplete="off"
          spellCheck={false}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={8}
          placeholder={'# Runbook: …\n\nWhat to check first, then the steps to fix it.'}
          className="font-data mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
      </label>
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
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="ui-btn ui-btn-secondary ui-btn-sm"
        >
          <UploadSimple size={14} weight="bold" />
          Load a .md / .txt file
        </button>
        <span className="text-xs text-zinc-500">{content.length.toLocaleString()} characters</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-300"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || content.trim().length < 20}
          onClick={() => void submit()}
          className="ui-btn ui-btn-primary ui-btn-sm"
        >
          {saving ? 'Chunking & indexing…' : 'Add and index'}
        </button>
      </div>
    </div>
  )
}
