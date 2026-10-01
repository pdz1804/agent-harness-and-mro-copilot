import { CaretRight } from '@phosphor-icons/react'
import { useId, type ReactNode } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { isGroupOpen, navGroupStorageKey } from '../../lib/nav-fold'

interface NavGroupProps {
  label: string
  /** Number of items, shown while folded. */
  count: number
  /** The current page lives in this group: it is forced open (and shows the
   * iris dot if it were folded). */
  active: boolean
  children: ReactNode
}

/** A foldable sidebar section. The header is a real button with
 * `aria-expanded`/`aria-controls`; the chevron turns 0 -> 90deg on the snappy
 * spring. The folded state is remembered per browser under
 * `nav.groups.<label>` and the group holding the current page is always open. */
export function NavGroup({ label, count, active, children }: NavGroupProps) {
  const [stored, setStored] = useLocalStorageState<boolean>(navGroupStorageKey(label), true)
  const open = isGroupOpen(stored, active)
  const listId = useId()
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        // The active group cannot be folded away; say so instead of a dead click.
        title={active ? 'Holds the current page, so it stays open' : undefined}
        onClick={() => {
          if (!active) setStored(!open)
        }}
        className="group flex h-7 w-full items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
      >
        <span className="flex-1 text-left">{label}</span>
        {!open && (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-400 tabular-nums">
            {active && <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-label="contains the current page" />}
            {count}
          </span>
        )}
        <CaretRight size={11} weight="bold" className="ui-fold-chevron shrink-0 text-zinc-400 group-hover:text-zinc-600" />
      </button>
      <div id={listId} hidden={!open} className="mt-0.5 space-y-px">
        {children}
      </div>
    </div>
  )
}
