import { Button } from '../ui'

/** Inline "Discard changes?" prompt shown at the top of a sheet body when the
 * user closes a dirty form. The sheet stays open until they decide. */
export function DiscardBar({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <div role="alertdialog" aria-label="Discard changes?" className="mb-4 flex flex-wrap items-center gap-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[13px] text-amber-900 ring-1 ring-amber-200 ring-inset">
      <span className="min-w-0 flex-1 font-medium">Discard changes?</span>
      <Button variant="ghost" size="sm" onClick={onKeep}>
        Keep editing
      </Button>
      <Button variant="danger-solid" size="sm" onClick={onDiscard} autoFocus>
        Discard
      </Button>
    </div>
  )
}
