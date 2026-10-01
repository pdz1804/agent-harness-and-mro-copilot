import { X } from '@phosphor-icons/react'
import { useEffect, type ReactNode } from 'react'
import { Button } from './Button'

interface BulkBarProps {
  count: number
  /** "session" -> "3 sessions selected". */
  noun: string
  onClear: () => void
  /** Bulk action buttons (secondary / danger). */
  children: ReactNode
}

/** Floating glass bar for multi-select actions, docked bottom-centre of the
 * page while at least one row is selected. Escape clears the selection. */
export function BulkBar({ count, noun, onClear, children }: BulkBarProps) {
  useEffect(() => {
    if (count === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[data-anchored-layer], [data-sheet], [data-command-palette]')) onClear()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [count, onClear])

  if (count === 0) return null
  return (
    <div className="pointer-events-none sticky bottom-3 z-30 mt-3 flex justify-center">
      <div
        role="toolbar"
        aria-label={`Actions for ${count} selected ${noun}${count === 1 ? '' : 's'}`}
        className="ui-glass pointer-events-auto flex max-w-full animate-toast-in flex-wrap items-center gap-2 rounded-[20px] py-1.5 pr-1.5 pl-3.5"
      >
        <span className="text-[13px] font-medium text-zinc-900 tabular-nums" aria-live="polite">
          {count} {noun}
          {count === 1 ? '' : 's'} selected
        </span>
        <span className="h-4 w-px bg-[var(--color-line-strong)]" aria-hidden="true" />
        {children}
        <Button variant="ghost" size="sm" iconOnly icon={<X size={13} weight="bold" />} aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear} />
      </div>
    </div>
  )
}
