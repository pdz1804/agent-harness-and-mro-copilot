import { Button } from '../ui'

/** Sheet footer shown instead of the normal actions when a dirty sheet is
 * closed: the user either keeps editing or throws the changes away. */
export function DiscardFooter({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <>
      <span className="mr-auto text-[13px] font-medium text-zinc-900">Discard changes?</span>
      <Button variant="ghost" onClick={onKeep}>
        Keep editing
      </Button>
      <Button variant="danger-solid" onClick={onDiscard}>
        Discard
      </Button>
    </>
  )
}
