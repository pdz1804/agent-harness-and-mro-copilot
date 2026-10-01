import { DotsThree } from '@phosphor-icons/react'
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AnchoredLayer } from './AnchoredLayer'
import { ConfirmPanel } from './ConfirmPopover'

export interface RowAction {
  label: string
  icon?: ReactNode
  onSelect: () => void | Promise<unknown>
  destructive?: boolean
  disabled?: boolean
  /** Shown under a disabled item, so the reason is readable on touch and by keyboard. */
  disabledReason?: string
  /** Ask before running: the menu turns into a confirm naming the object. */
  confirm?: { title: string; description?: string; confirmLabel?: string }
}

interface RowActionsProps {
  items: RowAction[]
  /** Accessible name, e.g. `Actions for "Payments outage"`. */
  label: string
  /** `reveal` (default): hidden until the row is hovered or focused (always
   * visible on touch). `always`: a permanently visible ⋯ (detail headers). */
  visibility?: 'reveal' | 'always'
  className?: string
}

/** The ⋯ overflow menu for a row or a detail header. Arrow keys move, Enter
 * runs, Escape closes. A destructive item with `confirm` swaps the menu for a
 * confirm in place, so there is still one popover and no layout jump. */
export function RowActions({ items, label, visibility = 'reveal', className = '' }: RowActionsProps) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<RowAction | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const close = () => {
    setOpen(false)
    setConfirming(null)
  }

  const focusItem = (delta: 1 | -1) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? [])
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + delta + buttons.length) % buttons.length].focus()
  }

  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusItem(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusItem(-1)
    }
  }

  const select = (item: RowAction) => {
    if (item.disabled) return
    if (item.confirm) {
      setConfirming(item)
      return
    }
    close()
    void item.onSelect()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
          setConfirming(null)
          // Focus the first item once the layer has mounted.
          requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')?.focus())
        }}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-[opacity,background-color,color] duration-150 hover:bg-zinc-950/[0.06] hover:text-zinc-900 aria-expanded:bg-zinc-950/[0.06] aria-expanded:text-zinc-900 aria-expanded:opacity-100 ${
          visibility === 'reveal' ? 'ui-reveal' : ''
        } ${className}`}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      <AnchoredLayer anchorRef={triggerRef} open={open} onClose={close} label={confirming ? confirming.confirm!.title : label} role={confirming ? 'dialog' : 'menu'}>
        {confirming ? (
          <ConfirmPanel
            title={confirming.confirm!.title}
            description={confirming.confirm!.description}
            confirmLabel={confirming.confirm!.confirmLabel ?? confirming.label}
            onConfirm={confirming.onSelect}
            onCancel={close}
          />
        ) : (
          <div ref={listRef} className="min-w-44 p-1" onKeyDown={onMenuKey} onClick={(e) => e.stopPropagation()}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => select(item)}
                className={`flex w-full items-start gap-2.5 rounded-[14px] px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100 focus-visible:outline-none disabled:cursor-not-allowed ${
                  item.disabled
                    ? 'text-zinc-400'
                    : item.destructive
                      ? 'text-rose-700 hover:bg-rose-50 focus-visible:bg-rose-50'
                      : 'text-zinc-800 hover:bg-zinc-950/[0.05] focus-visible:bg-zinc-950/[0.05]'
                }`}
              >
                {item.icon && <span className="mt-0.5 shrink-0 opacity-80">{item.icon}</span>}
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  {item.disabled && item.disabledReason && <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{item.disabledReason}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </AnchoredLayer>
    </>
  )
}
