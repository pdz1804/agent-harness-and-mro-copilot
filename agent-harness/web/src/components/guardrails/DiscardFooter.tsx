import { Button } from '../ui'

/** Sheet footer shown in place of the normal actions once the user tries to
 * close a sheet with unsaved edits: ask, then keep editing or discard. */
export function DiscardFooter({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <>
      <span className="mr-auto text-[13px] font-medium text-zinc-900" role="alert">
        Discard changes?
      </span>
      <Button variant="ghost" onClick={onKeep} autoFocus>
        Keep editing
      </Button>
      <Button variant="danger-solid" onClick={onDiscard}>
        Discard
      </Button>
    </>
  )
}
