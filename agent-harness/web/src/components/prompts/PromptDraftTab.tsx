import { PlusCircle, Seal, Trash } from '@phosphor-icons/react'
import type { PromptVerification } from '../../lib/api-types'
import { Button, Card, ConfirmPopover, Field, Input, Switch, Textarea } from '../ui'
import { VerificationPanel } from './VerificationPanel'

export interface PromptDraft {
  content: string
  note: string
}

interface PromptDraftTabProps {
  draft: PromptDraft
  onDraftChange: (next: PromptDraft) => void
  onDiscard: () => void
  activate: boolean
  onActivateChange: (next: boolean) => void
  review: boolean
  onReviewChange: (next: boolean) => void
  verification: PromptVerification | null
  verifying: boolean
  saving: boolean
  canWrite: boolean
  writeReason: string
  onVerify: () => void
  onCreate: () => void
}

/** Write the next version, check it against the lint rules (and optionally the
 * LLM reviewer) before saving, then create it, optionally activating it. */
export function PromptDraftTab({ draft, onDraftChange, onDiscard, activate, onActivateChange, review, onReviewChange, verification, verifying, saving, canWrite, writeReason, onVerify, onCreate }: PromptDraftTabProps) {
  const empty = !draft.content.trim()
  const dirty = !empty || !!draft.note.trim()
  return (
    <Card className="space-y-4">
      <Field label="New version" hint="The full replacement text. Versions are immutable: saving creates v+1, it never edits an old one.">
        {({ id, ...aria }) => (
          <Textarea
            id={id}
            {...aria}
            name="new-version"
            autoComplete="off"
            value={draft.content}
            onChange={(e) => onDraftChange({ ...draft, content: e.target.value })}
            rows={10}
            disabled={!canWrite}
            title={canWrite ? undefined : writeReason}
            placeholder="Full replacement content for the new version"
            className="w-full font-data text-[13px]"
          />
        )}
      </Field>

      {verification && (
        <div className="rounded-[10px] border border-[var(--color-line)] bg-zinc-50 p-3">
          <VerificationPanel verification={verification} />
        </div>
      )}

      <Field label="Change note" optional>
        {({ id, ...aria }) => <Input id={id} {...aria} name="change-note" autoComplete="off" value={draft.note} onChange={(e) => onDraftChange({ ...draft, note: e.target.value })} disabled={!canWrite} placeholder="What changed and why" className="w-full" />}
      </Field>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-zinc-700">
        <span className="flex items-center gap-2">
          <Switch label="Activate if verification passes" checked={activate} onChange={onActivateChange} disabled={!canWrite} />
          Activate if verification passes
        </span>
        <span className="flex items-center gap-2">
          <Switch label="Also run LLM review" checked={review} onChange={onReviewChange} disabled={!canWrite} />
          Also run LLM review
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-line)] pt-3">
        {!canWrite && <span className="mr-auto text-xs text-zinc-500">{writeReason}</span>}
        {dirty && canWrite && (
          <ConfirmPopover variant="ghost" icon={<Trash size={14} />} prompt="Discard this draft?" description="The text and note are cleared. This can't be undone." confirmLabel="Discard" onConfirm={onDiscard} className="mr-auto">
            Discard draft
          </ConfirmPopover>
        )}
        <Button icon={<Seal size={14} weight="bold" />} loading={verifying} disabled={empty || !canWrite} title={canWrite ? undefined : writeReason} onClick={onVerify}>
          {verifying ? 'Verifying' : 'Verify draft'}
        </Button>
        <Button variant="primary" icon={<PlusCircle size={14} weight="bold" />} loading={saving} disabled={empty || !canWrite} title={canWrite ? undefined : writeReason} onClick={onCreate}>
          {saving ? 'Saving' : 'Create version'}
        </Button>
      </div>
    </Card>
  )
}
