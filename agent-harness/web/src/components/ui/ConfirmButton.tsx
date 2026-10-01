import { useEffect, useRef, useState, type ReactNode } from 'react'

interface ConfirmButtonProps {
  /** Runs only after the second, explicit click. */
  onConfirm: () => void
  /** The question shown while armed, e.g. `Delete "Payments dashboard"?`. */
  prompt: string
  children: ReactNode
  className?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** Label of the confirming button (default "Delete"). */
  confirmLabel?: string
}

/** A destructive action behind an inline two-step confirm (no `window.confirm`,
 * no modal): the first click swaps the button for a short question with
 * Confirm / Cancel; Escape or clicking Cancel disarms it. */
export function ConfirmButton({
  onConfirm,
  prompt,
  children,
  className,
  disabled,
  title,
  ariaLabel,
  confirmLabel = 'Delete',
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!armed) return
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArmed(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [armed])

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onClick={() => setArmed(true)}
      >
        {children}
      </button>
    )
  }

  return (
    <span role="group" aria-label={prompt} className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-rose-700 [overflow-wrap:anywhere]">{prompt}</span>
      <button
        ref={confirmRef}
        type="button"
        className="ui-btn ui-btn-danger-solid ui-btn-sm"
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  )
}
