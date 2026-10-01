import { ArrowsClockwise, ChatCircleDots, FileText, GitDiff, Lock, PencilSimple, PlusCircle, ShareNetwork, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { canWriteResource, disabledReason, useMe } from '../../hooks/useMe'
import { useUrlEnum, useUrlState } from '../../hooks/useUrlState'
import { api, errorText } from '../../lib/api'
import type { PromptDetail as PromptDetailData, PromptVerification } from '../../lib/api-types'
import { isForbidden } from '../../lib/prompts-access'
import { PROMPT_KIND_LABELS, previousActiveId } from '../../lib/prompts-list'
import { Button, Chip, CopyId, ErrorState, PageHeader, RelativeTime, RowActions, Segmented, Skeleton, useToast, type RowAction } from '../ui'
import { ForbiddenState } from './ForbiddenState'
import { PlaygroundPanel } from './PlaygroundPanel'
import { PromptDiffTab } from './PromptDiffTab'
import { PromptDraftTab, type PromptDraft } from './PromptDraftTab'
import { PromptVersionsTab } from './PromptVersionsTab'

const TABS = ['versions', 'diff', 'draft', 'playground'] as const
type Tab = (typeof TABS)[number]
const EMPTY_DRAFT: PromptDraft = { content: '', note: '' }

/** One prompt in full: versions, diff, draft + verify, and the playground.
 * This is a page, not a sheet: the diff and the side-by-side playground need
 * the width. Tab and diff sides live in the URL; the unsaved draft is kept in
 * localStorage so leaving the page never loses it. */
export function PromptDetail({ promptId }: { promptId: string }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  const [tab, setTab] = useUrlEnum<Tab>('tab', TABS, 'versions')
  const [fromId, setFromId] = useUrlState('from')
  const [toId, setToId] = useUrlState('to')

  const [detail, setDetail] = useState<PromptDetailData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loadToken, setLoadToken] = useState(0)
  const [draft, setDraft] = useLocalStorageState<PromptDraft>(`prompts.draft.${promptId}`, EMPTY_DRAFT)
  const [activateOnCreate, setActivateOnCreate] = useState(true)
  const [reviewToo, setReviewToo] = useState(false)
  const [draftVerification, setDraftVerification] = useState<PromptVerification | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activatingId, setActivatingId] = useState<string | null>(null)
  const [reverifyingId, setReverifyingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const reload = useCallback(() => setLoadToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    api.getPrompt(promptId).then(
      (data) => {
        if (cancelled) return
        setDetail(data)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [promptId, loadToken])

  useDocumentTitle(detail?.name ?? null)

  const dirty = !!draft.content.trim() || !!draft.note.trim()
  // Closing the tab with an unsaved draft asks first (the draft is also kept locally).
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const hasMutate = me ? me.permissions.includes('mutate_prompts') : true
  // Mirrors `agent_harness.rbac.can_write`: owner or admin only, shared or not.
  const canWrite = detail !== null && hasMutate && canWriteResource(me, detail)
  const writeReason = !hasMutate ? disabledReason(me, 'mutate_prompts') : detail && !canWriteResource(me, detail) ? `Only the owner (${detail.owner_id}) or an admin can edit this prompt.` : ''

  if (error && !detail) {
    return isForbidden(error) ? (
      <ForbiddenState what="this prompt" backTo="/prompts" backLabel="Back to prompts" />
    ) : (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Prompt" back={{ to: '/prompts', label: 'Prompts' }} />
        <ErrorState message={errorText(error, 'Could not load this prompt.')} onRetry={reload} />
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Prompt" back={{ to: '/prompts', label: 'Prompts' }} />
        <div className="space-y-3" role="status" aria-label="Loading">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    )
  }

  const markExpanded = (id: string) => setExpanded((prev) => new Set(prev).add(id))
  const toggleChecks = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const verifyDraft = async () => {
    if (!draft.content.trim()) return
    setVerifying(true)
    try {
      setDraftVerification(
        await api.verifyPromptDraft({
          content: draft.content,
          kind: detail.kind,
          required_placeholders: detail.required_placeholders ?? [],
          llm_review: reviewToo,
        }),
      )
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't verify the draft", description: errorText(err, 'Try again.') })
    } finally {
      setVerifying(false)
    }
  }

  /** Activate `versionId`; Undo re-activates the version that was active before. */
  const activate = async (versionId: string, version: number) => {
    const previousId = previousActiveId(detail)
    const previous = detail.versions.find((v) => v.id === previousId)
    setActivatingId(versionId)
    try {
      await api.activatePromptVersion(promptId, versionId)
      reload()
      toast({
        title: `v${version} is now active for ${detail.slug}`,
        description: detail.used_by_agents ? `${detail.used_by_agents} agent${detail.used_by_agents === 1 ? '' : 's'} use it from their next run.` : undefined,
        action:
          previous && previousId
            ? {
                label: 'Undo',
                run: async () => {
                  await api.activatePromptVersion(promptId, previousId)
                  reload()
                  toast({ title: `Back to v${previous.version}` })
                },
              }
            : undefined,
      })
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't activate v${version}`, description: errorText(err, 'Try again.') })
    } finally {
      setActivatingId(null)
    }
  }

  const createVersion = async () => {
    if (!draft.content.trim()) return
    const previousId = previousActiveId(detail)
    const previous = detail.versions.find((v) => v.id === previousId)
    setSaving(true)
    try {
      const created = await api.createPromptVersion(promptId, {
        content: draft.content.trim(),
        change_note: draft.note.trim() || undefined,
        activate: activateOnCreate,
        llm_review: reviewToo,
      })
      setDraft(EMPTY_DRAFT)
      setDraftVerification(null)
      reload()
      if (activateOnCreate && !created.activated) {
        // Saved, but verification blocked activation: show exactly which rule failed.
        markExpanded(created.id)
        setTab('versions')
        toast({ tone: 'error', title: `v${created.version} saved but not activated`, description: created.activation_blocked ?? 'Verification failed.' })
        return
      }
      setTab('versions')
      toast({
        title: `v${created.version} created${created.activated ? ' and activated' : ''}`,
        action:
          created.activated && previous && previousId
            ? {
                label: 'Undo',
                run: async () => {
                  await api.activatePromptVersion(promptId, previousId)
                  reload()
                  toast({ title: `Back to v${previous.version}` })
                },
              }
            : undefined,
      })
    } catch (err) {
      const verification = (err as { detail?: { verification?: PromptVerification } } | null)?.detail?.verification
      if (verification) setDraftVerification(verification)
      toast({ tone: 'error', title: "Couldn't create the version", description: errorText(err, 'Try again.') })
    } finally {
      setSaving(false)
    }
  }

  const reverify = async (versionId: string, withReview: boolean) => {
    setReverifyingId(versionId)
    try {
      await api.verifyPromptVersion(promptId, versionId, withReview)
      markExpanded(versionId)
      reload()
    } catch (err) {
      toast({ tone: 'error', title: "Couldn't verify the version", description: errorText(err, 'Try again.') })
    } finally {
      setReverifyingId(null)
    }
  }

  const remove = async () => {
    try {
      await api.deletePrompt(promptId)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${detail.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    navigate('/prompts')
    toast({
      title: `Deleted “${detail.name}”`,
      description: 'Kept in the trash. Undo brings it back with every version.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restorePrompt(promptId)
          navigate(`/prompts/${promptId}`)
          toast({ title: 'Delete undone' })
        },
      },
    })
  }

  const menu: RowAction[] = [
    {
      label: 'Refresh',
      icon: <ArrowsClockwise size={14} />,
      onSelect: reload,
    },
    {
      label: 'Delete prompt',
      icon: <Trash size={14} />,
      destructive: true,
      disabled: !canWrite,
      disabledReason: writeReason,
      confirm: { title: `Delete “${detail.name}”?`, description: 'All versions go to the trash with it. You can undo for a few seconds.' },
      onSelect: remove,
    },
  ]

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ to: '/prompts', label: 'Prompts' }}
        title={detail.name}
        description={detail.description ?? undefined}
        meta={
          <>
            <Chip>{PROMPT_KIND_LABELS[detail.kind]}</Chip>
            {detail.active_version ? (
              <Chip tone="ok" dot>
                v{detail.active_version.version} active
              </Chip>
            ) : (
              <Chip tone="warn">No active version</Chip>
            )}
            <CopyId value={detail.slug} label="slug" />
            <Chip tone="muted" icon={detail.visibility === 'private' ? <Lock size={11} /> : <ShareNetwork size={11} />}>
              {detail.visibility === 'private' ? 'Private' : 'Shared'}
            </Chip>
            <span>
              Owner <span className="font-data">{detail.owner_id}</span>
            </span>
            <span>
              Used by {detail.used_by_agents} agent{detail.used_by_agents === 1 ? '' : 's'}
            </span>
            <span>
              Updated <RelativeTime value={detail.updated_at} />
            </span>
            {dirty && (
              <Chip tone="warn" dot icon={<PencilSimple size={11} />}>
                Unsaved draft
              </Chip>
            )}
          </>
        }
        actions={
          <>
            <RowActions visibility="always" label={`More actions for “${detail.name}”`} items={menu} />
            <Button variant="primary" icon={<PlusCircle size={14} weight="bold" />} disabled={!canWrite} title={canWrite ? undefined : writeReason} onClick={() => setTab('draft')}>
              New version
            </Button>
          </>
        }
        toolbar={
          <Segmented
            label="Prompt view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'versions', label: 'Versions', icon: <FileText size={13} weight="bold" />, count: detail.versions.length },
              { value: 'diff', label: 'Diff', icon: <GitDiff size={13} weight="bold" /> },
              { value: 'draft', label: 'Check draft', icon: <PencilSimple size={13} weight="bold" /> },
              { value: 'playground', label: 'Playground', icon: <ChatCircleDots size={13} weight="bold" /> },
            ]}
          />
        }
      />

      {!canWrite && writeReason && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-zinc-600">
          <Lock size={12} aria-hidden="true" />
          Read-only. {writeReason}
        </p>
      )}

      {tab === 'versions' && (
        <PromptVersionsTab
          detail={detail}
          canWrite={canWrite}
          writeReason={writeReason}
          activatingId={activatingId}
          reverifyingId={reverifyingId}
          expanded={expanded}
          onToggleChecks={toggleChecks}
          onActivate={(id) => {
            const v = detail.versions.find((x) => x.id === id)
            if (v) void activate(id, v.version)
          }}
          onDiff={(id) => {
            setFromId(detail.active_version?.id ?? '')
            setToId(id)
            setTab('diff')
          }}
          onReverify={(id, review) => void reverify(id, review)}
        />
      )}
      {tab === 'diff' && (
        <PromptDiffTab
          detail={detail}
          fromId={fromId || null}
          toId={toId || null}
          onChange={({ from, to }) => {
            setFromId(from)
            setToId(to)
          }}
        />
      )}
      {tab === 'draft' && (
        <PromptDraftTab
          draft={draft}
          onDraftChange={(next) => {
            setDraft(next)
            setDraftVerification(null)
          }}
          onDiscard={() => {
            setDraft(EMPTY_DRAFT)
            setDraftVerification(null)
          }}
          activate={activateOnCreate}
          onActivateChange={setActivateOnCreate}
          review={reviewToo}
          onReviewChange={setReviewToo}
          verification={draftVerification}
          verifying={verifying}
          saving={saving}
          canWrite={canWrite}
          writeReason={writeReason}
          onVerify={() => void verifyDraft()}
          onCreate={() => void createVersion()}
        />
      )}
      {tab === 'playground' && (
        <PlaygroundPanel
          detail={detail}
          draft={draft.content}
          onDraftChange={(content) => {
            setDraft({ ...draft, content })
            setDraftVerification(null)
          }}
          canRun={hasMutate}
          runDisabledReason={hasMutate ? undefined : disabledReason(me, 'mutate_prompts')}
        />
      )}
    </div>
  )
}
