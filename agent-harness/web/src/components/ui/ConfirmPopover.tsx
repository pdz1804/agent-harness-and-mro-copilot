import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnchoredLayer } from './AnchoredLayer'
import { Button, type ButtonSize, type ButtonVariant } from './Button'

interface ConfirmPanelProps {
  /** The question, naming the object: `Delete session "Payments outage"?` */
  title: string
  /** What happens next, e.g. "You can undo this for a few seconds." */
  description?: string
  confirmLabel?: string
  /** `danger` (default) for destructive actions; `primary` for a confirm that isn't. */
  tone?: 'danger' | 'primary'
  onConfirm: () => void | Promise<unknown>
  onCancel: () => void
}

/** The body of every confirm: question, consequence, [Cancel] [Confirm]. The
 * confirm button is focused on open and shows a spinner while an async
 * `onConfirm` is in flight; Escape cancels (handled by the layer). */
export function ConfirmPanel({ title, description, confirmLabel = 'Delete', tone = 'danger', onConfirm, onCancel }: ConfirmPanelProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => confirmRef.current?.focus(), [])

  const run = async () => {
    setPending(true)
    try {
      await onConfirm()
    } catch {
      // Callers report their own failures (an error toast with Retry); the
      // popover only has to close and stop spinning.
    } finally {
      setPending(false)
      onCancel()
    }
  }

  return (
    <div className="w-72 max-w-[calc(100vw-1rem)] p-3.5">
      <p className="text-sm font-semibold text-zinc-950 [overflow-wrap:anywhere]">{title}</p>
      {description && <p className="mt-1 text-[13px] leading-snug text-zinc-600">{description}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant={tone === 'danger' ? 'danger-solid' : 'primary'} size="sm" onClick={() => void run()} loading={pending}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

interface ConfirmPopoverProps extends Omit<ConfirmPanelProps, 'onCancel' | 'title'> {
  /** The question shown in the popover (names the object). */
  prompt: string
  children?: ReactNode
  /** Trigger look: the same props as `Button`. */
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  iconOnly?: boolean
  className?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  align?: 'start' | 'end'
}

/** A button that asks first: a small anchored popover names the object and
 * the consequence, never `window.confirm` and never an inline swap that moves
 * the layout. Replaces every hand-rolled "Delete? Yes/No". */
export function ConfirmPopover({ prompt, children, variant = 'danger', size, icon, iconOnly, className, disabled, title, ariaLabel, align = 'end', ...panel }: ConfirmPopoverProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        icon={icon}
        iconOnly={iconOnly}
        className={className}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </Button>
      <AnchoredLayer anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} label={prompt} align={align}>
        <ConfirmPanel title={prompt} {...panel} onCancel={() => setOpen(false)} />
      </AnchoredLayer>
    </>
  )
}
