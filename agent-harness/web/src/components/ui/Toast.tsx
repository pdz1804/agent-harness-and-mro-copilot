import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface ToastOptions {
  title: string
  description?: string
  tone?: 'ok' | 'error'
  /** One follow-up: "Undo" (reverses the mutation) or "Open" (goes to the result). */
  action?: { label: string; run: () => void | Promise<unknown> }
  /** ms before it dismisses itself; hovering or focusing pauses the clock. */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  leaving: boolean
}

type ToastFn = (options: ToastOptions) => number

const ToastContext = createContext<ToastFn | null>(null)

/** `toast({...})` from anywhere under `ToastProvider`. Outside a provider
 * (isolated tests) it is a silent no-op rather than a crash. */
export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop
}

const noop: ToastFn = () => 0
const LEAVE_MS = 160
const MAX_VISIBLE = 3

/** The one feedback channel for mutations: bottom-right on desktop,
 * bottom-centre on mobile, newest on top, at most 3, `aria-live=polite`
 * (errors are `assertive`). Each toast carries at most one action, usually
 * Undo, and running it dismisses the toast. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), LEAVE_MS)
  }, [])

  const toast = useCallback<ToastFn>((options) => {
    const id = nextId.current++
    setItems((list) => [{ ...options, id, leaving: false }, ...list].slice(0, MAX_VISIBLE))
    return id
  }, [])

  const value = useMemo(() => toast, [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        data-toast-stack=""
        className="pointer-events-none fixed inset-x-0 bottom-3 z-[70] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} onFail={(title) => toast({ title, tone: 'error' })} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ item, onDismiss, onFail }: { item: ToastItem; onDismiss: () => void; onFail: (title: string) => void }) {
  const [paused, setPaused] = useState(false)
  const [running, setRunning] = useState(false)
  const duration = item.duration ?? (item.action ? 6000 : 4000)

  useEffect(() => {
    if (paused || item.leaving) return
    const timer = window.setTimeout(onDismiss, duration)
    return () => window.clearTimeout(timer)
  }, [paused, item.leaving, duration, onDismiss])

  const isError = item.tone === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      data-testid="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`ui-glass pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-[20px] py-2.5 pr-2 pl-3.5 text-zinc-900 ${
        item.leaving ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      {isError ? (
        <WarningCircle size={18} weight="fill" className="mt-px shrink-0 text-rose-600" aria-hidden="true" />
      ) : (
        <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-emerald-600" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 py-px">
        <p className="text-[13px] font-medium [overflow-wrap:anywhere]">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-zinc-600 [overflow-wrap:anywhere]">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          disabled={running}
          onClick={async () => {
            setRunning(true)
            try {
              await item.action!.run()
            } catch (err) {
              // An Undo that fails must say so: the change it meant to revert stands.
              onFail(err instanceof Error && err.message ? `${item.action!.label} failed: ${err.message}` : `${item.action!.label} failed. Try again from the page.`)
            } finally {
              onDismiss()
            }
          }}
          className="shrink-0 rounded-md px-2 py-1 text-[13px] font-semibold text-sky-700 transition-colors hover:bg-sky-50 hover:text-sky-800 disabled:opacity-60"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900"
      >
        <X size={13} weight="bold" />
      </button>
    </div>
  )
}
