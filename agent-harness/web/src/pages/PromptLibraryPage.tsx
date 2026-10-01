import {
  ArrowClockwise,
  CaretLeft,
  CheckCircle,
  ChatCircleDots,
  FileText,
  Lock,
  PlusCircle,
  Seal,
  ShareNetwork,
  Trash,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PlaygroundPanel } from '../components/prompts/PlaygroundPanel'
import { VerificationBadge, VerificationPanel } from '../components/prompts/VerificationPanel'
import { DiffView } from '../components/ui/DiffView'
import { EmptyState } from '../components/EmptyState'
import { ErrorBanner } from '../components/ErrorBanner'
import { Skeleton } from '../components/Skeleton'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { ApiError, api } from '../lib/api'
import type { CreatedPromptVersion, PromptDetail, PromptKind, PromptSummary, PromptVerification } from '../lib/api-types'
import { activationLabel, summarizeVerification } from '../lib/prompt-verification'
import { PageHeader } from '../components/ui/PageHeader'
import { ConfirmButton } from '../components/ui/ConfirmButton'

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const KIND_LABELS: Record<PromptKind, string> = {
  system: 'System',
  skill_router: 'Skill router',
  judge: 'Judge',
}

const KIND_FILTERS: Array<{ value: PromptKind | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'system', label: 'System' },
  { value: 'skill_router', label: 'Skill router' },
  { value: 'judge', label: 'Judge' },
]

/** Prompt Library (phase 02): a named, versioned library of system prompts
 * — `ops-system` (used by every run today), plus `skill-router` and
 * `eval-judge` (seeded now, wired into the loop in phases 04/07).
 * Two-pane on desktop (list left, detail right); on narrow viewports the
 * list is shown until a prompt is selected, then the detail drills in
 * (back arrow returns to the list) — see the `md:` breakpoints below. */
export function PromptLibraryPage() {
  const { promptId } = useParams<{ promptId?: string }>()
  const navigate = useNavigate()

  const [prompts, setPrompts] = useState<PromptSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<PromptKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [showNewForm, setShowNewForm] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .listPrompts(kindFilter === 'all' ? undefined : { kind: kindFilter })
      .then((data) => {
        if (!cancelled) setPrompts(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load prompts.')
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken, kindFilter])

  // On wide screens open the first prompt instead of leaving the detail pane
  // as an empty placeholder (on mobile the list IS the page, so keep it).
  useEffect(() => {
    if (promptId || !prompts || prompts.length === 0) return
    if (window.matchMedia('(min-width: 768px)').matches) navigate(`/prompts/${prompts[0].id}`, { replace: true })
  }, [promptId, prompts, navigate])

  const filtered = useMemo(() => {
    if (!prompts) return null
    if (!query.trim()) return prompts
    const q = query.trim().toLowerCase()
    return prompts.filter(
      (p) =>
        p.slug.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    )
  }, [prompts, query])

  const refresh = () => setRefreshToken((n) => n + 1)
  const { me } = useMe()
  const canCreate = me ? me.permissions.includes('mutate_prompts') : true

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Prompt Library"
        description={<>Versioned system prompts. The active version of{' '}
            <span className="font-data">ops-system</span> is used to build every new run's agent.</>}
        actions={<><div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="ui-btn ui-btn-secondary"
          >
            <ArrowClockwise size={14} weight="bold" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowNewForm((v) => !v)}
            disabled={!canCreate}
            title={canCreate ? undefined : disabledReason(me, 'mutate_prompts')}
            className="ui-btn ui-btn-primary"
          >
            <PlusCircle size={14} weight="bold" />
            New prompt
          </button>
        </div></>}
      />

      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} onRetry={refresh} />
        </div>
      )}

      {showNewForm && (
        <NewPromptForm
          onCreated={(created) => {
            setShowNewForm(false)
            refresh()
            navigate(`/prompts/${created.id}`)
          }}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        <div className={promptId ? 'hidden md:block' : ''}>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setKindFilter(f.value)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  kindFilter === f.value
                    ? 'border-sky-300 bg-sky-100 text-sky-700'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input name="input" autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, slug, description…"
            className="mb-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          />

          {filtered === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-4 text-sm text-zinc-500">No prompts match.</p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/prompts/${p.id}`)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      p.id === promptId
                        ? 'border-sky-300 bg-sky-50/60'
                        : 'border-zinc-200 bg-white hover:border-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileText size={13} className="shrink-0 text-zinc-500" />
                      <span className="truncate text-sm font-medium text-zinc-900">{p.name}</span>
                      {p.visibility === 'private' ? (
                        <Lock size={12} className="shrink-0 text-zinc-500" />
                      ) : (
                        <ShareNetwork size={12} className="shrink-0 text-zinc-500" />
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-data text-xs text-zinc-500">{p.slug}</p>
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
                      <span className="rounded-full bg-zinc-100 px-1.5 py-0.5">
                        {KIND_LABELS[p.kind]}
                      </span>
                      <span>
                        {p.version_count} version{p.version_count === 1 ? '' : 's'}
                      </span>
                      <span>· {p.owner_id}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={promptId ? '' : 'hidden md:block'}>
          {promptId ? (
            <PromptDetailPane
              promptId={promptId}
              onBack={() => navigate('/prompts')}
              onChanged={refresh}
            />
          ) : (
            <EmptyState
              icon={<FileText size={32} />}
              title="Select a prompt"
              description="Choose a prompt from the list to view its version history."
            />
          )}
        </div>
      </div>
    </div>
  )
}

function NewPromptForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: PromptDetail) => void
  onCancel: () => void
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<PromptKind>('system')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedVerification, setFailedVerification] = useState<PromptVerification | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [preview, setPreview] = useState<PromptVerification | null>(null)

  const canSubmit = slug.trim() && name.trim() && content.trim() && !creating

  const verifyDraft = async () => {
    setVerifying(true)
    setError(null)
    try {
      setPreview(await api.verifyPromptDraft({ content, kind }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify the draft.')
    } finally {
      setVerifying(false)
    }
  }

  const submit = async () => {
    if (!canSubmit) return
    setCreating(true)
    setError(null)
    setFailedVerification(null)
    try {
      const created = await api.createPrompt({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        visibility,
        content: content.trim(),
      })
      onCreated(created)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create prompt.')
      const detail = err instanceof ApiError ? (err.detail as { verification?: PromptVerification } | undefined) : undefined
      if (detail && typeof detail === 'object' && detail.verification) setFailedVerification(detail.verification)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mt-4 ui-card space-y-2.5 p-4">
      {error && <ErrorBanner message={error} />}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label className="block text-xs font-medium text-zinc-500">
          Slug
          <input name="input" autoComplete="off"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-new-prompt…"
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          />
        </label>
        <label className="block text-xs font-medium text-zinc-500">
          Name
          <input name="input" autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          />
        </label>
        <label className="block text-xs font-medium text-zinc-500">
          Kind
          <select name="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as PromptKind)}
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          >
            <option value="system">System</option>
            <option value="skill_router">Skill router</option>
            <option value="judge">Judge</option>
          </select>
        </label>
        <label className="block text-xs font-medium text-zinc-500">
          Visibility
          <select name="select"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
          >
            <option value="private">Private (only me + admin)</option>
            <option value="shared">Shared (everyone can read)</option>
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium text-zinc-500">
        Description (optional)
        <input name="input" autoComplete="off"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
      </label>
      <label className="block text-xs font-medium text-zinc-500">
        Initial content (v1)
        <textarea name="textarea" autoComplete="off"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
      </label>
      {(failedVerification ?? preview) && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <VerificationPanel verification={(failedVerification ?? preview)!} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!content.trim() || verifying}
          onClick={() => void verifyDraft()}
          className="ui-btn ui-btn-secondary ui-btn-sm"
        >
          <Seal size={14} weight="bold" />
          {verifying ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="ui-btn ui-btn-primary ui-btn-sm"
        >
          {creating ? 'Creating…' : 'Create prompt'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-300"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function PromptDetailPane({
  promptId,
  onBack,
  onChanged,
}: {
  promptId: string
  onBack: () => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<PromptDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadToken, setLoadToken] = useState(0)
  const [newContent, setNewContent] = useState('')
  const [changeNote, setChangeNote] = useState('')
  const [activateOnCreate, setActivateOnCreate] = useState(true)
  const [saving, setSaving] = useState(false)
  const [diffAgainst, setDiffAgainst] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<'versions' | 'playground'>('versions')
  const [draftVerification, setDraftVerification] = useState<PromptVerification | null>(null)
  const [verifyingDraft, setVerifyingDraft] = useState(false)
  const [reviewToo, setReviewToo] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [reverifying, setReverifying] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setDetail(null)
    api
      .getPrompt(promptId)
      .then((data) => {
        if (!cancelled) {
          setDetail(data)
          setDiffAgainst(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load prompt.')
      })
    return () => {
      cancelled = true
    }
  }, [promptId, loadToken])

  const activeContent = useMemo(
    () => detail?.versions.find((v) => v.id === detail.active_version?.id)?.content ?? '',
    [detail],
  )
  const diffVersion = useMemo(
    () => detail?.versions.find((v) => v.id === diffAgainst) ?? null,
    [detail, diffAgainst],
  )

  const reload = () => {
    setLoadToken((n) => n + 1)
    onChanged()
  }

  const { me: detailMe } = useMe()
  const hasMutatePermission = detailMe ? detailMe.permissions.includes('mutate_prompts') : true
  // Mirrors `agent_harness.rbac.can_write`: owner or admin only — a
  // `shared` prompt is readable by anyone but still only writable by its
  // owner/admin, same as a private one.
  const canWrite = detail !== null && hasMutatePermission && canWriteResource(detailMe, detail)

  const verifyDraft = async () => {
    if (!detail || !newContent.trim()) return
    setVerifyingDraft(true)
    setError(null)
    try {
      setDraftVerification(
        await api.verifyPromptDraft({
          content: newContent,
          kind: detail.kind,
          required_placeholders: detail.required_placeholders ?? [],
          llm_review: reviewToo,
        }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify the draft.')
    } finally {
      setVerifyingDraft(false)
    }
  }

  const submitVersion = async () => {
    if (!newContent.trim()) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const created: CreatedPromptVersion = await api.createPromptVersion(promptId, {
        content: newContent.trim(),
        change_note: changeNote.trim() || undefined,
        activate: activateOnCreate,
        llm_review: reviewToo,
      })
      if (activateOnCreate && !created.activated) {
        // Saved, but verification blocked activation: keep the author on the
        // result so they can see exactly which rule failed.
        setNotice(`v${created.version} was saved but NOT activated: ${created.activation_blocked ?? 'verification failed'}.`)
        setExpanded((prev) => new Set(prev).add(created.id))
      } else {
        setNotice(`v${created.version} created${created.activated ? ' and activated' : ''}.`)
      }
      setNewContent('')
      setChangeNote('')
      setDraftVerification(null)
      reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create version.')
    } finally {
      setSaving(false)
    }
  }

  const reverify = async (versionId: string, withReview: boolean) => {
    setReverifying(versionId)
    setError(null)
    try {
      await api.verifyPromptVersion(promptId, versionId, withReview)
      setExpanded((prev) => new Set(prev).add(versionId))
      reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify the version.')
    } finally {
      setReverifying(null)
    }
  }

  const activate = async (versionId: string) => {
    setSaving(true)
    setError(null)
    try {
      await api.activatePromptVersion(promptId, versionId)
      reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to activate version.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!detail) return
    setDeleting(true)
    setError(null)
    try {
      await api.deletePrompt(promptId)
      onChanged()
      onBack()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete prompt.')
      setDeleting(false)
    }
  }

  if (error && !detail) {
    return <ErrorBanner message={error} onRetry={reload} />
  }
  if (!detail) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 md:hidden"
          >
            <CaretLeft size={12} weight="bold" />
            Back to list
          </button>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-zinc-900">{detail.name}</h2>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
              {KIND_LABELS[detail.kind]}
            </span>
          </div>
          <p className="font-data text-xs text-zinc-500">{detail.slug}</p>
          {detail.description && <p className="mt-1 text-sm text-zinc-600">{detail.description}</p>}
        </div>
        <ConfirmButton
          prompt={`Delete "${detail.name}"? This cannot be undone.`}
          disabled={deleting}
          onConfirm={() => void remove()}
          className="ui-btn ui-btn-danger ui-btn-sm shrink-0"
          title="Delete (soft-archive) this prompt"
        >
          <Trash size={14} />
          {deleting ? 'Deleting…' : 'Delete'}
        </ConfirmButton>
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800" role="status">
          {notice}
        </p>
      )}

      <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 text-xs" role="tablist" aria-label="Prompt view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'versions'}
          onClick={() => setTab('versions')}
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition ${
            tab === 'versions' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <FileText size={13} weight="bold" />
          Versions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'playground'}
          onClick={() => setTab('playground')}
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition ${
            tab === 'playground' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <ChatCircleDots size={13} weight="bold" />
          Playground
        </button>
      </div>

      {tab === 'playground' && (
        <PlaygroundPanel
          detail={detail}
          draft={newContent}
          onDraftChange={(value) => {
            setNewContent(value)
            setDraftVerification(null)
          }}
          canRun={hasMutatePermission}
        />
      )}

      {tab === 'versions' && (
      <>
      <div className="ui-card p-4">
        <p className="mb-1.5 text-xs font-medium text-zinc-500 ">
          Active content (v{detail.active_version?.version ?? '—'})
        </p>
        <pre className="max-h-64 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm whitespace-pre-wrap text-zinc-800">
          {activeContent || '(no active version)'}
        </pre>
      </div>

      <div className="ui-card p-4">
        <p className="mb-1.5 text-xs font-medium text-zinc-500 ">
          New version
        </p>
        <textarea name="textarea" autoComplete="off"
          value={newContent}
          onChange={(e) => {
            setNewContent(e.target.value)
            setDraftVerification(null)
          }}
          rows={5}
          placeholder="Full replacement content for the new version…"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
        {draftVerification && (
          <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <VerificationPanel verification={draftVerification} />
          </div>
        )}
        <input name="input" autoComplete="off"
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          placeholder="Change note (optional)…"
          className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-600">
              <input name="input"
                type="checkbox"
                checked={activateOnCreate}
                onChange={(e) => setActivateOnCreate(e.target.checked)}
              />
              Activate if verification passes
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-600">
              <input name="input" type="checkbox" checked={reviewToo} onChange={(e) => setReviewToo(e.target.checked)} />
              Also run LLM review
            </label>
          </div>
          <button
            type="button"
            disabled={verifyingDraft || !newContent.trim() || !hasMutatePermission}
            onClick={() => void verifyDraft()}
            className="ui-btn ui-btn-secondary ui-btn-sm"
          >
            <Seal size={14} weight="bold" />
            {verifyingDraft ? 'Verifying…' : 'Verify draft'}
          </button>
          <button
            type="button"
            disabled={saving || !newContent.trim() || !canWrite}
            title={canWrite ? undefined : disabledReason(detailMe, 'mutate_prompts')}
            onClick={() => void submitVersion()}
            className="ui-btn ui-btn-primary ui-btn-sm"
          >
            <PlusCircle size={14} weight="bold" />
            {saving ? 'Saving…' : 'Create version'}
          </button>
        </div>
      </div>

      <div className="ui-card p-4">
        <p className="mb-2 text-xs font-medium text-zinc-500 ">
          Version history ({detail.versions.length})
        </p>
        <ul className="space-y-2">
          {detail.versions.map((v) => (
            <li
              key={v.id}
              className={`rounded-lg border p-3 ${
                v.id === detail.active_version?.id
                  ? 'border-sky-300 bg-sky-50/50'
                  : 'border-zinc-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900">v{v.version}</span>
                  {v.id === detail.active_version?.id && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
                      <CheckCircle size={12} weight="fill" />
                      Active
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    {formatTimestamp(v.created_at)} · {v.created_by}
                  </span>
                  <VerificationBadge verification={v.verification} />
                </div>
                <div className="flex items-center gap-2">
                  {v.id !== detail.active_version?.id && (
                    <button
                      type="button"
                      onClick={() => setDiffAgainst(v.id === diffAgainst ? null : v.id)}
                      className="text-xs font-medium text-zinc-500 hover:text-sky-700"
                    >
                      {diffAgainst === v.id ? 'Hide diff' : 'Diff vs active'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(v.id)) next.delete(v.id)
                        else next.add(v.id)
                        return next
                      })
                    }
                    className="text-xs font-medium text-zinc-500 hover:text-sky-700"
                  >
                    {expanded.has(v.id) ? 'Hide checks' : 'Checks'}
                  </button>
                  {v.id !== detail.active_version?.id && (
                    <button
                      type="button"
                      disabled={saving || !canWrite || !summarizeVerification(v.verification).activatable}
                      title={
                        !canWrite
                          ? disabledReason(detailMe, 'mutate_prompts')
                          : !summarizeVerification(v.verification).activatable
                            ? 'Lint failed: fix the errors in a new version first'
                            : undefined
                      }
                      onClick={() => void activate(v.id)}
                      className="rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 hover:border-sky-300 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {activationLabel(v.version, detail.active_version?.version ?? null)}
                    </button>
                  )}
                </div>
              </div>
              {v.change_note && <p className="mt-1 text-xs text-zinc-500">{v.change_note}</p>}
              <p className="mt-1 text-xs text-zinc-500" data-testid="version-usage">
                Used by {v.run_count ?? 0} run{(v.run_count ?? 0) === 1 ? '' : 's'} · pinned by {v.pinned_agents ?? 0} agent
                {(v.pinned_agents ?? 0) === 1 ? '' : 's'}
              </p>
              {expanded.has(v.id) && (
                <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  {v.verification ? (
                    <VerificationPanel verification={v.verification} />
                  ) : (
                    <p className="text-xs text-zinc-500">
                      No verification stored for this version yet (it predates verification). It is linted when
                      you activate it.
                    </p>
                  )}
                  {canWrite && (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={reverifying === v.id}
                        onClick={() => void reverify(v.id, false)}
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:border-sky-300 hover:text-sky-700 disabled:opacity-50"
                      >
                        Re-run lint
                      </button>
                      <button
                        type="button"
                        disabled={reverifying === v.id}
                        onClick={() => void reverify(v.id, true)}
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:border-sky-300 hover:text-sky-700 disabled:opacity-50"
                      >
                        {reverifying === v.id ? 'Reviewing…' : 'Lint + LLM review'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {diffAgainst === v.id && diffVersion && (
                <div className="mt-2">
                  <DiffView before={activeContent} after={diffVersion.content} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      </>
      )}
    </div>
  )
}
