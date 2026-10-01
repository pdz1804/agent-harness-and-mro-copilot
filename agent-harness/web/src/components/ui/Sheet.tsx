import { CaretDown, CaretUp, X } from '@phosphor-icons/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isTypingTarget } from '../../lib/keyboard'
import { Button } from './Button'

interface SheetProps {
  open: boolean
  onClose: () => void
  /** Accessible name and visible title. */
  title: ReactNode
  /** Plain-text name for the dialog when `title` is not a string. */
  label?: string
  /** Breadcrumb-like line above the title ("Knowledge / Documents"). */
  eyebrow?: ReactNode
  /** Status chip / ID right after the title. */
  status?: ReactNode
  /** Key facts row under the title. */
  meta?: ReactNode
  /** Header controls before prev/next/close: usually a `RowActions` ⋯ menu. */
  headerActions?: ReactNode
  /** ←/→ (and the header chevrons) step through the list behind the sheet. */
  onPrev?: () => void
  onNext?: () => void
  /** Sticky footer: the primary action sits right-most. */
  footer?: ReactNode
  width?: 'md' | 'lg' | 'xl'
  children: ReactNode
}

const WIDTH = { md: 'lg:w-[30rem]', lg: 'lg:w-[36rem]', xl: 'lg:w-[44rem]' } as const

/** The one detail sheet. It slides in from the right over the list (which
 * stays visible and clickable on desktop, so picking another row switches the
 * sheet), is near-solid glass (reading surface), has one scroll container
 * (the body) under a fixed header, and a sticky footer. Escape closes;
 * ←/→ move to the previous/next item unless you are typing. Focus moves into
 * the sheet on open and back to the opener on close. Below `lg` it becomes a
 * full-height panel over a dimmed backdrop. */
export function Sheet({ open, onClose, title, label, eyebrow, status, meta, headerActions, onPrev, onNext, footer, width = 'md', children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const handlers = useRef({ onClose, onPrev, onNext })
  handlers.current = { onClose, onPrev, onNext }

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        // A popover or the palette above the sheet handles its own Escape first.
        if (document.querySelector('[data-anchored-layer], [data-command-palette]')) return
        e.preventDefault()
        handlers.current.onClose()
      } else if (!isTypingTarget(e.target) && !(e.target as HTMLElement | null)?.closest?.('[role="tablist"]')) {
        const step = e.key === 'ArrowLeft' || e.key === 'k' ? handlers.current.onPrev : e.key === 'ArrowRight' || e.key === 'j' ? handlers.current.onNext : undefined
        if (step) {
          e.preventDefault()
          step()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const target = returnFocus.current
      if (target && document.contains(target)) target.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  const name = label ?? (typeof title === 'string' ? title : 'Details')

  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close details"
        onClick={onClose}
        className="fixed inset-0 z-40 animate-fade bg-zinc-950/25 lg:hidden"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={name}
        tabIndex={-1}
        data-sheet=""
        className={`ui-glass-solid fixed inset-x-0 top-[max(3rem,8vh)] bottom-0 z-40 flex animate-sheet-in flex-col overflow-hidden rounded-t-[20px] outline-none lg:inset-x-auto lg:top-3 lg:right-3 lg:bottom-3 lg:max-w-[calc(100vw-1.5rem)] lg:rounded-[20px] ${WIDTH[width]}`}
      >
        <header className="shrink-0 border-b border-[var(--color-line)] px-5 pt-4 pb-3.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {eyebrow && <p className="mb-1 truncate text-xs text-zinc-500">{eyebrow}</p>}
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 font-[family-name:var(--font-display)] text-[17px] leading-6 font-semibold tracking-[-0.01em] text-zinc-950 [overflow-wrap:anywhere]">
                  {title}
                </h2>
                {status}
              </div>
              {meta && <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">{meta}</div>}
            </div>
            <div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center gap-0.5">
              {onPrev && <Button variant="ghost" iconOnly size="sm" icon={<CaretUp size={14} weight="bold" />} aria-label="Previous item" title="Previous (←)" onClick={onPrev} />}
              {onNext && <Button variant="ghost" iconOnly size="sm" icon={<CaretDown size={14} weight="bold" />} aria-label="Next item" title="Next (→)" onClick={onNext} />}
              {headerActions}
              <Button variant="ghost" iconOnly size="sm" icon={<X size={14} weight="bold" />} aria-label="Close" title="Close (Esc)" onClick={onClose} />
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </>,
    document.body,
  )
}

/** A labelled section inside a sheet body (Overview · Activity · Related · Raw). */
export function SheetSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5 [&+&]:mt-6">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-[family-name:var(--font-sans)] text-xs font-medium tracking-normal text-zinc-500">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Label/value rows for the sheet's facts. */
export function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-4 gap-y-2 text-[13px]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-zinc-500">{item.label}</dt>
          <dd className="min-w-0 text-zinc-900 [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
