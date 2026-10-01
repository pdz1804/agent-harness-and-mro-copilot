import { ArrowSquareOut, PencilSimple, Trash } from '@phosphor-icons/react'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import type { Memory } from '../../lib/api-types'
import { memoryUsage } from '../../lib/memory-list'
import { Button, Card, Chip, ConfirmPanel, ConfirmPopover, CopyId, ErrorState, FactList, LinkButton, RelativeTime, RowActions, Sheet, SheetSection, SheetSkeleton, type RowAction } from '../ui'
import { MEMORY_FORM_ID, MemoryEditor } from './MemoryEditor'

interface MemorySheetProps {
  /** Open straight into the editor (the row's Edit action). */
  startEditing?: boolean
  /** `null` is the "Remember a fact" flow. */
  memory: Memory | null
  /** For `?open=<id>` links: the memory is still being looked up, or does not exist. */
  lookup?: 'ready' | 'loading' | 'missing'
  /** Why this user cannot edit or delete the memory, else null. */
  blockedReason: string | null
  showOwner: boolean
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onSave: (fact: string, tags: string[]) => Promise<void>
  onDelete: () => Promise<unknown>
}

const titleOf = (fact: string) => (fact.length > 72 ? `${fact.slice(0, 72).trimEnd()}…` : fact)

/** One memory in a sheet over the list (`/memory?open=<id>`), also the home of
 * editing (fact + tags) and of the add flow. Leaving an edit with unsaved
 * changes asks "Discard changes?" first. */
export function MemorySheet({ startEditing = false, memory, lookup = 'ready', blockedReason, showOwner, onClose, onPrev, onNext, onSave, onDelete }: MemorySheetProps) {
  const navigate = useNavigate()
  const adding = memory === null && lookup === 'ready'
  const [editing, setEditing] = useState(startEditing)
  const [form, setForm] = useState({ dirty: false, saving: false })
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const onStateChange = useCallback((state: { dirty: boolean; saving: boolean }) => setForm(state), [])

  const editorOpen = adding || editing
  useDocumentTitle(memory ? titleOf(memory.fact) : adding ? 'Remember a fact' : null)

  /** Run `action` now, or after the user confirms losing unsaved edits. */
  const leave = (action: () => void) => {
    if (form.saving) return
    if (editorOpen && form.dirty) setPendingLeave(() => action)
    else action()
  }

  const save = async (fact: string, tags: string[]) => {
    await onSave(fact, tags)
    setEditing(false)
    setForm({ dirty: false, saving: false })
  }

  const actions: RowAction[] = memory
    ? [
        {
          label: 'Edit',
          icon: <PencilSimple size={14} />,
          disabled: blockedReason !== null,
          disabledReason: blockedReason ?? undefined,
          onSelect: () => setEditing(true),
        },
        ...(memory.source_run_id ? [{ label: 'Open source chat', icon: <ArrowSquareOut size={14} />, onSelect: () => navigate(`/runs/${memory.source_run_id}`) }] : []),
        {
          label: 'Delete',
          icon: <Trash size={14} />,
          destructive: true,
          disabled: blockedReason !== null,
          disabledReason: blockedReason ?? undefined,
          confirm: { title: 'Delete this memory?', description: `“${titleOf(memory.fact)}” stops being recalled. You can undo for a few seconds.` },
          onSelect: onDelete,
        },
      ]
    : []

  const footer = pendingLeave ? (
    <div className="w-full rounded-[14px] bg-white ring-1 ring-[var(--color-line)] [&>div]:w-full">
      <ConfirmPanel title="Discard changes?" description="What you typed will be lost." confirmLabel="Discard" onConfirm={pendingLeave} onCancel={() => setPendingLeave(null)} />
    </div>
  ) : editorOpen ? (
    <>
      <Button variant="ghost" disabled={form.saving} onClick={() => leave(adding ? onClose : () => setEditing(false))}>
        Cancel
      </Button>
      <Button type="submit" form={MEMORY_FORM_ID} variant="primary" loading={form.saving}>
        {adding ? 'Save memory' : 'Save changes'}
      </Button>
    </>
  ) : memory ? (
    <>
      {blockedReason && <p className="w-full min-w-0 text-xs text-zinc-500">{blockedReason}</p>}
      <ConfirmPopover
        icon={<Trash size={14} />}
        prompt="Delete this memory?"
        description={`“${titleOf(memory.fact)}” stops being recalled. You can undo for a few seconds.`}
        disabled={blockedReason !== null}
        title={blockedReason ?? undefined}
        onConfirm={onDelete}
      >
        Delete
      </ConfirmPopover>
      <Button variant="primary" icon={<PencilSimple size={14} weight="bold" />} disabled={blockedReason !== null} title={blockedReason ?? undefined} onClick={() => setEditing(true)}>
        Edit
      </Button>
    </>
  ) : undefined

  return (
    <Sheet
      open
      onClose={() => leave(onClose)}
      onPrev={editorOpen ? undefined : onPrev}
      onNext={editorOpen ? undefined : onNext}
      eyebrow="Memory"
      label={memory ? titleOf(memory.fact) : adding ? 'Remember a fact' : 'Memory'}
      title={memory ? titleOf(memory.fact) : adding ? 'Remember a fact' : 'Memory'}
      status={memory && showOwner ? <Chip>{memory.owner_name}</Chip> : undefined}
      meta={
        memory && (
          <>
            <CopyId value={memory.id} label="memory ID" />
            <span aria-hidden="true">·</span>
            <span>
              Saved <RelativeTime value={memory.created_at} />
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{memoryUsage(memory)}</span>
          </>
        )
      }
      headerActions={memory && !editorOpen ? <RowActions visibility="always" label="More actions for this memory" items={actions} /> : undefined}
      footer={footer}
    >
      {adding ? (
        <MemoryEditor autoFocus onSubmit={onSave} onStateChange={onStateChange} />
      ) : lookup === 'loading' ? (
        <SheetSkeleton />
      ) : !memory ? (
        <ErrorState message="This memory no longer exists. It may have been deleted." />
      ) : editing ? (
        <MemoryEditor autoFocus initialFact={memory.fact} initialTags={memory.tags} onSubmit={save} onStateChange={onStateChange} />
      ) : (
        <>
          <SheetSection title="Fact">
            <Card padding="sm">
              <p className="text-[13px] whitespace-pre-wrap text-zinc-900 [overflow-wrap:anywhere]">{memory.fact}</p>
            </Card>
            {memory.tags.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
                {memory.tags.map((tag) => (
                  <li key={tag}>
                    <Chip>{tag}</Chip>
                  </li>
                ))}
              </ul>
            )}
          </SheetSection>
          <SheetSection title="Overview">
            <FactList
              items={[
                { label: 'Saved', value: <RelativeTime value={memory.created_at} /> },
                { label: 'Updated', value: <RelativeTime value={memory.updated_at} /> },
                { label: 'Recalled', value: memory.use_count === 0 ? 'Not recalled yet' : <span className="tabular-nums">{memoryUsage(memory)}, last <RelativeTime value={memory.last_used_at} fallback="never" /></span> },
                { label: 'Source', value: memory.source_run_id ? <LinkButton to={`/runs/${memory.source_run_id}`} variant="link">Saved in a chat</LinkButton> : 'Added by hand' },
                { label: 'Owner', value: memory.owner_name },
              ]}
            />
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
